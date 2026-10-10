//! Process-wide admission control for external requests. No credentials or URLs are stored.
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(25);
const MAX_RETRY_AFTER: Duration = Duration::from_secs(30 * 60);
const MAX_DISPATCHED_REQUESTS: usize = 48;

#[derive(Clone, Debug)]
struct Config {
    global_concurrency: usize,
    origin_concurrency: usize,
    global_rate: f64,
    global_burst: f64,
    origin_rate: f64,
    origin_burst: f64,
    global_queue: usize,
    origin_queue: usize,
    queue_timeout: Duration,
    failure_threshold: usize,
    failure_window: Duration,
    circuit_cooldown: Duration,
    max_origins: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            global_concurrency: 8,
            origin_concurrency: 3,
            global_rate: 4.0,
            global_burst: 8.0,
            origin_rate: 2.0,
            origin_burst: 3.0,
            global_queue: 32,
            origin_queue: 8,
            queue_timeout: Duration::from_secs(10),
            failure_threshold: 5,
            failure_window: Duration::from_secs(60),
            circuit_cooldown: Duration::from_secs(30),
            max_origins: 256,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AdmissionError {
    QueueFull,
    QueueTimeout,
    CircuitOpen,
    Cooldown,
    Cancelled,
}

impl fmt::Display for AdmissionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::QueueFull => "REQUEST_QUEUE_FULL：请求过多，等待队列已满，请稍后重试。",
            Self::QueueTimeout => "REQUEST_QUEUE_TIMEOUT：请求排队超时，尚未发送，请稍后重试。",
            Self::CircuitOpen => {
                "PROVIDER_CIRCUIT_OPEN：服务连续异常，正在冷却或探测恢复，请稍后重试。"
            }
            Self::Cooldown => {
                "PROVIDER_COOLDOWN：服务请求频率受限，正在按服务要求等待，请稍后重试。"
            }
            Self::Cancelled => "REQUEST_CANCELLED：请求已取消，尚未发送。",
        })
    }
}

impl std::error::Error for AdmissionError {}

pub(crate) fn is_admission_error(message: &str) -> bool {
    [
        "REQUEST_QUEUE_FULL",
        "REQUEST_QUEUE_TIMEOUT",
        "PROVIDER_CIRCUIT_OPEN",
        "PROVIDER_COOLDOWN",
        "REQUEST_CANCELLED",
    ]
    .iter()
    .any(|prefix| message.starts_with(prefix))
}

pub(crate) fn origin_key(secure: bool, host: &str, port: u16) -> String {
    let normalized = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let normalized = if normalized.contains(':') {
        format!("[{normalized}]")
    } else {
        normalized
    };
    format!(
        "{}://{}:{}",
        if secure { "https" } else { "http" },
        normalized,
        port
    )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Success,
    Failure,
    RateLimited(Duration),
    Neutral,
}

trait Clock: Send + Sync {
    fn now(&self) -> Duration;
}

struct MonotonicClock(Instant);

impl Clock for MonotonicClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
}

struct Bucket {
    tokens: f64,
    updated: Duration,
    rate: f64,
    capacity: f64,
}

impl Bucket {
    fn new(now: Duration, rate: f64, capacity: f64) -> Self {
        Self {
            tokens: capacity,
            updated: now,
            rate,
            capacity,
        }
    }

    fn available(&self, now: Duration) -> f64 {
        (self.tokens + now.saturating_sub(self.updated).as_secs_f64() * self.rate)
            .min(self.capacity)
    }

    fn consume(&mut self, now: Duration) {
        self.tokens = (self.available(now) - 1.0).max(0.0);
        self.updated = now;
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Circuit {
    Closed,
    Open { until: Duration },
    HalfOpen,
}

struct Origin {
    active: usize,
    queued: usize,
    bucket: Bucket,
    failures: VecDeque<Duration>,
    circuit: Circuit,
    cooldown_until: Duration,
    epoch: u64,
    last_used: Duration,
}

impl Origin {
    fn admission_error(&self, now: Duration) -> Option<AdmissionError> {
        if self.cooldown_until > now {
            return Some(AdmissionError::Cooldown);
        }
        match self.circuit {
            Circuit::HalfOpen => Some(AdmissionError::CircuitOpen),
            Circuit::Open { until } if until > now => Some(AdmissionError::CircuitOpen),
            _ => None,
        }
    }

    fn evictable(&self, now: Duration, failure_window: Duration) -> bool {
        self.active == 0
            && self.queued == 0
            && self.circuit == Circuit::Closed
            && self.cooldown_until <= now
            && self
                .failures
                .back()
                .is_none_or(|last| now.saturating_sub(*last) > failure_window)
            && self.bucket.available(now) >= self.bucket.capacity
    }
}

struct Queued {
    id: u64,
    origin: String,
    deadline: Duration,
}

struct State {
    active: usize,
    bucket: Bucket,
    origins: HashMap<String, Origin>,
    queue: VecDeque<Queued>,
    next_id: u64,
}

pub(crate) struct Scheduler {
    config: Config,
    clock: Arc<dyn Clock>,
    state: Mutex<State>,
    changed: Condvar,
}

impl Scheduler {
    fn new(config: Config, clock: Arc<dyn Clock>) -> Arc<Self> {
        let now = clock.now();
        Arc::new(Self {
            state: Mutex::new(State {
                active: 0,
                bucket: Bucket::new(now, config.global_rate, config.global_burst),
                origins: HashMap::new(),
                queue: VecDeque::new(),
                next_id: 0,
            }),
            config,
            clock,
            changed: Condvar::new(),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn enqueue(self: &Arc<Self>, origin: &str) -> Result<WaitingRequest, AdmissionError> {
        let now = self.clock.now();
        let mut state = self.lock();
        if !state.origins.contains_key(origin) {
            if state.origins.len() >= self.config.max_origins {
                let eviction = state
                    .origins
                    .iter()
                    .filter(|(_, entry)| entry.evictable(now, self.config.failure_window))
                    .min_by_key(|(_, entry)| entry.last_used)
                    .map(|(key, _)| key.clone());
                match eviction {
                    Some(key) => {
                        state.origins.remove(&key);
                    }
                    None => return Err(AdmissionError::QueueFull),
                }
            }
            state.origins.insert(
                origin.to_owned(),
                Origin {
                    active: 0,
                    queued: 0,
                    bucket: Bucket::new(now, self.config.origin_rate, self.config.origin_burst),
                    failures: VecDeque::new(),
                    circuit: Circuit::Closed,
                    cooldown_until: Duration::ZERO,
                    epoch: 0,
                    last_used: now,
                },
            );
        }
        let service = &state.origins[origin];
        if let Some(error) = service.admission_error(now) {
            return Err(error);
        }
        if state.queue.len() >= self.config.global_queue
            || service.queued >= self.config.origin_queue
        {
            return Err(AdmissionError::QueueFull);
        }
        let id = state.next_id;
        state.next_id = state.next_id.wrapping_add(1);
        let service = state.origins.get_mut(origin).expect("origin was inserted");
        service.queued += 1;
        service.last_used = now;
        state.queue.push_back(Queued {
            id,
            origin: origin.to_owned(),
            deadline: now.saturating_add(self.config.queue_timeout),
        });
        Ok(WaitingRequest {
            scheduler: self.clone(),
            ticket: Some(id),
        })
    }

    // Select the oldest eligible service head. A service lacking tokens or concurrency
    // cannot block other services, and newly arriving work cannot overtake eligible work.
    fn next_eligible(&self, state: &State, now: Duration) -> Option<u64> {
        if state.active >= self.config.global_concurrency || state.bucket.available(now) < 1.0 {
            return None;
        }
        let mut seen = HashSet::new();
        state.queue.iter().find_map(|request| {
            if request.deadline <= now || !seen.insert(&request.origin) {
                return None;
            }
            let service = &state.origins[&request.origin];
            (service.admission_error(now).is_none()
                && service.active < self.config.origin_concurrency
                && service.bucket.available(now) >= 1.0)
                .then_some(request.id)
        })
    }

    fn remove_ticket(state: &mut State, id: u64) -> Option<Queued> {
        let position = state.queue.iter().position(|request| request.id == id)?;
        let request = state.queue.remove(position)?;
        if let Some(service) = state.origins.get_mut(&request.origin) {
            service.queued -= 1;
        }
        Some(request)
    }

    fn complete(&self, token: PermitToken, outcome: Outcome) {
        let now = self.clock.now();
        let mut state = self.lock();
        state.active -= 1;
        let service = state
            .origins
            .get_mut(&token.origin)
            .expect("active origins cannot be evicted");
        service.active -= 1;
        service.last_used = now;
        // Even an older 429 has a meaningful Retry-After. It must not erase an existing
        // circuit transition, and an older success must never erase this cooldown.
        if let Outcome::RateLimited(delay) = outcome {
            service.cooldown_until = service
                .cooldown_until
                .max(now.saturating_add(delay.min(MAX_RETRY_AFTER)));
        }
        if token.epoch == service.epoch {
            match outcome {
                Outcome::Success => {
                    service.failures.clear();
                    service.circuit = Circuit::Closed;
                }
                Outcome::Failure => {
                    while service.failures.front().is_some_and(|failure| {
                        now.saturating_sub(*failure) > self.config.failure_window
                    }) {
                        service.failures.pop_front();
                    }
                    service.failures.push_back(now);
                    if token.probe || service.failures.len() >= self.config.failure_threshold {
                        service.circuit = Circuit::Open {
                            until: now.saturating_add(self.config.circuit_cooldown),
                        };
                        service.epoch = service.epoch.wrapping_add(1);
                        service.failures.clear();
                    }
                }
                Outcome::RateLimited(_) | Outcome::Neutral if token.probe => {
                    // Cancelled or throttled probes are inconclusive; allow a new probe
                    // after any Retry-After instead of leaving HalfOpen stuck forever.
                    service.circuit = Circuit::Open { until: now };
                }
                Outcome::RateLimited(_) | Outcome::Neutral => {}
            }
        }
        drop(state);
        self.changed.notify_all();
    }

    pub(crate) fn acquire(
        self: &Arc<Self>,
        origin: &str,
        cancelled: impl Fn() -> bool,
    ) -> Result<Permit, AdmissionError> {
        if cancelled() {
            return Err(AdmissionError::Cancelled);
        }
        let mut waiting = self.enqueue(origin)?;
        loop {
            if let Some(permit) = waiting.poll(cancelled())? {
                return Ok(permit);
            }
            // Native cancellation uses an existing atomic signal. A bounded timed wait
            // observes that signal even when no network operation completes to notify us.
            let state = self.lock();
            drop(
                self.changed
                    .wait_timeout(state, CANCEL_POLL_INTERVAL)
                    .unwrap_or_else(|error| error.into_inner()),
            );
        }
    }
}

struct WaitingRequest {
    scheduler: Arc<Scheduler>,
    ticket: Option<u64>,
}

impl WaitingRequest {
    fn poll(&mut self, cancelled: bool) -> Result<Option<Permit>, AdmissionError> {
        let id = self
            .ticket
            .expect("a waiting request is polled until completion");
        let now = self.scheduler.clock.now();
        let mut state = self.scheduler.lock();
        let request = state
            .queue
            .iter()
            .find(|request| request.id == id)
            .expect("waiting ticket remains queued");
        let error = if cancelled {
            Some(AdmissionError::Cancelled)
        } else if request.deadline <= now {
            Some(AdmissionError::QueueTimeout)
        } else {
            state.origins[&request.origin].admission_error(now)
        };
        if let Some(error) = error {
            Scheduler::remove_ticket(&mut state, id);
            self.ticket = None;
            drop(state);
            self.scheduler.changed.notify_all();
            return Err(error);
        }
        if self.scheduler.next_eligible(&state, now) != Some(id) {
            return Ok(None);
        }
        let request = Scheduler::remove_ticket(&mut state, id).expect("selected request is queued");
        self.ticket = None;
        state.active += 1;
        state.bucket.consume(now);
        let service = state
            .origins
            .get_mut(&request.origin)
            .expect("queued origin exists");
        service.active += 1;
        service.bucket.consume(now);
        service.last_used = now;
        let probe = matches!(service.circuit, Circuit::Open { .. });
        if probe {
            service.circuit = Circuit::HalfOpen;
        }
        let token = PermitToken {
            origin: request.origin,
            epoch: service.epoch,
            probe,
        };
        drop(state);
        self.scheduler.changed.notify_all();
        Ok(Some(Permit {
            scheduler: self.scheduler.clone(),
            token: Some(token),
        }))
    }
}

impl Drop for WaitingRequest {
    fn drop(&mut self) {
        if let Some(id) = self.ticket.take() {
            Scheduler::remove_ticket(&mut self.scheduler.lock(), id);
            self.scheduler.changed.notify_all();
        }
    }
}

struct PermitToken {
    origin: String,
    epoch: u64,
    probe: bool,
}

pub(crate) struct Permit {
    scheduler: Arc<Scheduler>,
    token: Option<PermitToken>,
}

impl Permit {
    pub(crate) fn finish(mut self, outcome: Outcome) {
        if let Some(token) = self.token.take() {
            self.scheduler.complete(token, outcome);
        }
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        if let Some(token) = self.token.take() {
            self.scheduler.complete(token, Outcome::Neutral);
        }
    }
}

pub(crate) fn acquire(
    origin: &str,
    cancelled: impl Fn() -> bool,
) -> Result<Permit, AdmissionError> {
    static SCHEDULER: OnceLock<Arc<Scheduler>> = OnceLock::new();
    SCHEDULER
        .get_or_init(|| Scheduler::new(Config::default(), Arc::new(MonotonicClock(Instant::now()))))
        .acquire(origin, cancelled)
}

#[cfg(test)]
pub(crate) fn isolated_for_tests() -> Arc<Scheduler> {
    Scheduler::new(Config::default(), Arc::new(MonotonicClock(Instant::now())))
}

struct DispatchLimiter {
    active: AtomicUsize,
    limit: usize,
}

impl DispatchLimiter {
    fn try_acquire(self: &Arc<Self>) -> Result<DispatchPermit, AdmissionError> {
        self.active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < self.limit).then_some(active + 1)
            })
            .map_err(|_| AdmissionError::QueueFull)?;
        Ok(DispatchPermit {
            limiter: self.clone(),
        })
    }
}

pub(crate) struct DispatchPermit {
    limiter: Arc<DispatchLimiter>,
}

impl Drop for DispatchPermit {
    fn drop(&mut self) {
        self.limiter.active.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(crate) fn try_dispatch() -> Result<DispatchPermit, AdmissionError> {
    static LIMITER: OnceLock<Arc<DispatchLimiter>> = OnceLock::new();
    LIMITER
        .get_or_init(|| {
            Arc::new(DispatchLimiter {
                active: AtomicUsize::new(0),
                limit: MAX_DISPATCHED_REQUESTS,
            })
        })
        .try_acquire()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64};
    use std::sync::{mpsc, Barrier};
    use std::thread;

    #[derive(Default)]
    struct ManualClock(AtomicU64);

    impl Clock for ManualClock {
        fn now(&self) -> Duration {
            Duration::from_millis(self.0.load(Ordering::Acquire))
        }
    }

    impl ManualClock {
        fn advance(&self, duration: Duration) {
            self.0
                .fetch_add(duration.as_millis() as u64, Ordering::AcqRel);
        }
    }

    fn fixture(config: Config) -> (Arc<Scheduler>, Arc<ManualClock>) {
        let clock = Arc::new(ManualClock::default());
        (Scheduler::new(config, clock.clone()), clock)
    }

    fn permit(scheduler: &Arc<Scheduler>, origin: &str) -> Permit {
        scheduler
            .enqueue(origin)
            .unwrap()
            .poll(false)
            .unwrap()
            .unwrap()
    }

    fn generous() -> Config {
        Config {
            global_rate: 100.0,
            global_burst: 100.0,
            origin_rate: 100.0,
            origin_burst: 100.0,
            ..Config::default()
        }
    }

    #[test]
    fn origin_normalization_shares_model_and_credential_independent_limits() {
        assert_eq!(
            origin_key(true, "API.Example.COM.", 443),
            "https://api.example.com:443"
        );
        assert_eq!(
            origin_key(false, "[2001:DB8::1]", 80),
            "http://[2001:db8::1]:80"
        );
        assert_ne!(origin_key(false, "a", 80), origin_key(true, "a", 443));
    }

    #[test]
    fn errors_have_stable_codes_and_chinese_explanations() {
        for error in [
            AdmissionError::QueueFull,
            AdmissionError::QueueTimeout,
            AdmissionError::CircuitOpen,
            AdmissionError::Cooldown,
            AdmissionError::Cancelled,
        ] {
            assert!(is_admission_error(&error.to_string()));
            assert!(error.to_string().contains('：'));
        }
        assert!(!is_admission_error("connection reset"));
    }

    #[test]
    fn concurrency_is_global_and_per_origin_and_drop_releases_slots() {
        let (scheduler, _) = fixture(Config {
            global_concurrency: 3,
            origin_concurrency: 2,
            ..generous()
        });
        let a1 = permit(&scheduler, "a");
        let a2 = permit(&scheduler, "a");
        let mut a3 = scheduler.enqueue("a").unwrap();
        assert!(a3.poll(false).unwrap().is_none());
        let b1 = permit(&scheduler, "b");
        let mut b2 = scheduler.enqueue("b").unwrap();
        assert!(b2.poll(false).unwrap().is_none());
        drop(a1);
        assert!(
            b2.poll(false).unwrap().is_none(),
            "the older eligible service gets the next slot"
        );
        drop(a3.poll(false).unwrap().unwrap());
        drop(b2.poll(false).unwrap().unwrap());
        drop((a2, b1));
        assert_eq!(scheduler.lock().active, 0);
    }

    #[test]
    fn global_and_service_bursts_refill_independently() {
        let (scheduler, clock) = fixture(Config {
            global_burst: 3.0,
            global_rate: 1.0,
            origin_burst: 2.0,
            origin_rate: 2.0,
            ..Config::default()
        });
        permit(&scheduler, "a").finish(Outcome::Success);
        permit(&scheduler, "a").finish(Outcome::Success);
        let mut a = scheduler.enqueue("a").unwrap();
        assert!(a.poll(false).unwrap().is_none());
        permit(&scheduler, "b").finish(Outcome::Success);
        let mut b = scheduler.enqueue("b").unwrap();
        clock.advance(Duration::from_millis(500));
        assert!(
            a.poll(false).unwrap().is_none(),
            "global token is still missing"
        );
        clock.advance(Duration::from_millis(500));
        assert!(
            b.poll(false).unwrap().is_none(),
            "newer service cannot steal the replenished token"
        );
        a.poll(false).unwrap().unwrap().finish(Outcome::Success);
        assert!(b.poll(false).unwrap().is_none());
        clock.advance(Duration::from_secs(1));
        b.poll(false).unwrap().unwrap().finish(Outcome::Success);
    }

    #[test]
    fn queue_is_bounded_and_cancellation_timeout_and_drop_remove_tickets() {
        let (scheduler, clock) = fixture(Config {
            global_concurrency: 1,
            global_queue: 2,
            origin_queue: 1,
            ..generous()
        });
        let running = permit(&scheduler, "running");
        let mut a = scheduler.enqueue("a").unwrap();
        assert!(matches!(
            scheduler.enqueue("a"),
            Err(AdmissionError::QueueFull)
        ));
        let b = scheduler.enqueue("b").unwrap();
        assert!(matches!(
            scheduler.enqueue("c"),
            Err(AdmissionError::QueueFull)
        ));
        assert!(matches!(a.poll(true), Err(AdmissionError::Cancelled)));
        assert_eq!(scheduler.lock().queue.len(), 1);
        drop(b);
        assert_eq!(scheduler.lock().queue.len(), 0);
        let mut c = scheduler.enqueue("c").unwrap();
        clock.advance(Duration::from_secs(10));
        assert!(matches!(c.poll(false), Err(AdmissionError::QueueTimeout)));
        assert_eq!(scheduler.lock().queue.len(), 0);
        drop(running);
        assert_eq!(scheduler.lock().active, 0);
    }

    #[test]
    fn circuit_isolated_with_single_probe_and_old_success_cannot_close_it() {
        let (scheduler, clock) = fixture(Config {
            failure_threshold: 2,
            ..generous()
        });
        let old_success = permit(&scheduler, "a");
        permit(&scheduler, "a").finish(Outcome::Failure);
        permit(&scheduler, "a").finish(Outcome::Failure);
        old_success.finish(Outcome::Success);
        assert!(matches!(
            scheduler.enqueue("a"),
            Err(AdmissionError::CircuitOpen)
        ));
        permit(&scheduler, "b").finish(Outcome::Success);
        clock.advance(Duration::from_secs(30));
        let probe = permit(&scheduler, "a");
        assert!(matches!(
            scheduler.enqueue("a"),
            Err(AdmissionError::CircuitOpen)
        ));
        probe.finish(Outcome::Failure);
        assert!(matches!(
            scheduler.enqueue("a"),
            Err(AdmissionError::CircuitOpen)
        ));
        clock.advance(Duration::from_secs(30));
        permit(&scheduler, "a").finish(Outcome::Success);
        permit(&scheduler, "a").finish(Outcome::Success);
        assert_eq!(scheduler.lock().origins["a"].circuit, Circuit::Closed);
    }

    #[test]
    fn old_failure_cannot_reopen_after_new_epoch_probe_success() {
        let (scheduler, clock) = fixture(Config {
            failure_threshold: 1,
            ..generous()
        });
        let old = permit(&scheduler, "a");
        permit(&scheduler, "a").finish(Outcome::Failure);
        clock.advance(Duration::from_secs(30));
        permit(&scheduler, "a").finish(Outcome::Success);
        old.finish(Outcome::Failure);
        assert_eq!(scheduler.lock().origins["a"].circuit, Circuit::Closed);
    }

    #[test]
    fn failures_are_consecutive_and_bounded_by_the_time_window() {
        let (scheduler, clock) = fixture(Config {
            failure_threshold: 2,
            ..generous()
        });
        permit(&scheduler, "a").finish(Outcome::Failure);
        permit(&scheduler, "a").finish(Outcome::Success);
        permit(&scheduler, "a").finish(Outcome::Failure);
        clock.advance(Duration::from_secs(61));
        permit(&scheduler, "a").finish(Outcome::Failure);
        assert_eq!(scheduler.lock().origins["a"].circuit, Circuit::Closed);
        permit(&scheduler, "a").finish(Outcome::Failure);
        assert!(matches!(
            scheduler.enqueue("a"),
            Err(AdmissionError::CircuitOpen)
        ));
    }

    #[test]
    fn queued_requests_reject_when_circuit_opens_without_consuming_tokens() {
        let (scheduler, _) = fixture(Config {
            origin_concurrency: 1,
            failure_threshold: 1,
            ..generous()
        });
        let active = permit(&scheduler, "a");
        let mut queued = scheduler.enqueue("a").unwrap();
        active.finish(Outcome::Failure);
        let tokens = scheduler.lock().bucket.tokens;
        assert!(matches!(
            queued.poll(false),
            Err(AdmissionError::CircuitOpen)
        ));
        assert_eq!(scheduler.lock().bucket.tokens, tokens);
        assert!(scheduler.lock().queue.is_empty());
    }

    #[test]
    fn retry_after_is_bounded_and_success_cannot_erase_cooldown() {
        let (scheduler, clock) = fixture(generous());
        let success = permit(&scheduler, "a");
        permit(&scheduler, "a").finish(Outcome::RateLimited(Duration::from_secs(7200)));
        success.finish(Outcome::Success);
        assert!(matches!(
            scheduler.enqueue("a"),
            Err(AdmissionError::Cooldown)
        ));
        permit(&scheduler, "b").finish(Outcome::Success);
        clock.advance(Duration::from_secs(1799));
        assert!(matches!(
            scheduler.enqueue("a"),
            Err(AdmissionError::Cooldown)
        ));
        clock.advance(Duration::from_secs(1));
        permit(&scheduler, "a").finish(Outcome::Success);
        assert!(scheduler.lock().origins["a"].failures.is_empty());
    }

    #[test]
    fn neutral_or_throttled_probe_releases_half_open_without_counting_failure() {
        let (scheduler, clock) = fixture(Config {
            failure_threshold: 1,
            ..generous()
        });
        permit(&scheduler, "a").finish(Outcome::Failure);
        clock.advance(Duration::from_secs(30));
        drop(permit(&scheduler, "a"));
        permit(&scheduler, "a").finish(Outcome::RateLimited(Duration::from_secs(3)));
        assert!(matches!(
            scheduler.enqueue("a"),
            Err(AdmissionError::Cooldown)
        ));
        clock.advance(Duration::from_secs(3));
        permit(&scheduler, "a").finish(Outcome::Success);
        assert_eq!(scheduler.lock().origins["a"].circuit, Circuit::Closed);
    }

    #[test]
    fn service_state_eviction_preserves_rate_limits_failures_and_cooldowns() {
        let (scheduler, clock) = fixture(Config {
            max_origins: 1,
            origin_burst: 1.0,
            origin_rate: 1.0,
            ..generous()
        });
        permit(&scheduler, "a").finish(Outcome::Neutral);
        assert!(
            matches!(scheduler.enqueue("b"), Err(AdmissionError::QueueFull)),
            "depleted buckets cannot be evicted"
        );
        clock.advance(Duration::from_secs(1));
        permit(&scheduler, "b").finish(Outcome::RateLimited(Duration::from_secs(30)));
        assert_eq!(scheduler.lock().origins.len(), 1);
        clock.advance(Duration::from_secs(1));
        assert!(
            matches!(scheduler.enqueue("a"), Err(AdmissionError::QueueFull)),
            "cooldowns cannot be evicted"
        );
        clock.advance(Duration::from_secs(29));
        permit(&scheduler, "a").finish(Outcome::Failure);
        clock.advance(Duration::from_secs(1));
        assert!(
            matches!(scheduler.enqueue("b"), Err(AdmissionError::QueueFull)),
            "recent failures cannot be evicted"
        );
        clock.advance(Duration::from_secs(60));
        permit(&scheduler, "b").finish(Outcome::Success);
        assert_eq!(scheduler.lock().origins.len(), 1);
    }

    #[test]
    fn concurrent_requests_never_exceed_global_capacity() {
        let (scheduler, _) = fixture(Config {
            global_concurrency: 3,
            origin_concurrency: 3,
            ..generous()
        });
        let barrier = Arc::new(Barrier::new(13));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let handles: Vec<_> = (0..12)
            .map(|index| {
                let scheduler = scheduler.clone();
                let barrier = barrier.clone();
                let active = active.clone();
                let peak = peak.clone();
                thread::spawn(move || {
                    barrier.wait();
                    let guard = scheduler
                        .acquire(&format!("service-{}", index % 3), || false)
                        .unwrap();
                    let concurrent = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(concurrent, Ordering::SeqCst);
                    for _ in 0..20 {
                        thread::yield_now();
                    }
                    active.fetch_sub(1, Ordering::SeqCst);
                    guard.finish(Outcome::Success);
                })
            })
            .collect();
        barrier.wait();
        for handle in handles {
            handle.join().unwrap();
        }
        assert!(peak.load(Ordering::SeqCst) <= 3);
        assert_eq!(scheduler.lock().active, 0);
        assert!(scheduler.lock().queue.is_empty());
    }

    #[test]
    fn blocking_wait_observes_cancellation_without_completion_notification() {
        let (scheduler, _) = fixture(Config {
            global_concurrency: 1,
            ..generous()
        });
        let running = permit(&scheduler, "a");
        let cancelled = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker_scheduler = scheduler.clone();
        let worker_cancelled = cancelled.clone();
        let worker = thread::spawn(move || {
            let checks = AtomicUsize::new(0);
            worker_scheduler.acquire("b", || {
                let was_cancelled = worker_cancelled.load(Ordering::Acquire);
                // Signal after enqueue and after reading false for the first poll.
                // The caller then cancels without notifying the scheduler.
                if checks.fetch_add(1, Ordering::Relaxed) == 1 {
                    ready_tx.send(()).unwrap();
                }
                was_cancelled
            })
        });
        ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        cancelled.store(true, Ordering::Release);
        assert!(matches!(
            worker.join().unwrap(),
            Err(AdmissionError::Cancelled)
        ));
        assert!(scheduler.lock().queue.is_empty());
        drop(running);
    }

    #[test]
    fn dispatch_pool_is_bounded_and_raii_releases_capacity() {
        let limiter = Arc::new(DispatchLimiter {
            active: AtomicUsize::new(0),
            limit: MAX_DISPATCHED_REQUESTS,
        });
        let mut permits: Vec<_> = (0..MAX_DISPATCHED_REQUESTS)
            .map(|_| limiter.try_acquire().unwrap())
            .collect();
        assert!(matches!(
            limiter.try_acquire(),
            Err(AdmissionError::QueueFull)
        ));
        permits.pop();
        let last = limiter.try_acquire().unwrap();
        drop(permits);
        drop(last);
        assert_eq!(limiter.active.load(Ordering::Acquire), 0);
    }
}
