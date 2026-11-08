//! Opt-in real-provider acceptance. Uses isolated settings/project data and the normal
//! Windows credential boundary; never exports credentials or submits media jobs.
use super::*;
use serde_json::{json, Value};
use std::time::Instant;

fn has_shot_number(text: &str, number: usize) -> bool {
    if text.lines().any(|line| {
        let line = line.trim();
        line.starts_with('|')
            && line
                .split('|')
                .nth(1)
                .and_then(|cell| cell.trim().parse::<usize>().ok())
                == Some(number)
    }) {
        return true;
    }
    [
        format!("镜{number}"),
        format!("镜头{number}"),
        format!("第{number}镜"),
    ]
    .iter()
    .any(|marker| {
        text.match_indices(marker).any(|(offset, matched)| {
            !text[offset + matched.len()..]
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_digit())
        })
    })
}

#[test]
fn acceptance_recognizes_shot_numbers_in_headings_and_tables() {
    let table = "| 镜号 | 时长 |\n|---|---|\n| 1 | 8秒 |\n| 2 | 10秒 |";
    assert!(has_shot_number(table, 1));
    assert!(has_shot_number(table, 2));
    assert!(!has_shot_number(table, 3));
    assert!(has_shot_number("## 镜1｜0–8秒", 1));
    assert!(has_shot_number("镜头2：走近", 2));
    assert!(has_shot_number("第3镜", 3));
    assert!(!has_shot_number("镜头12", 1));
    assert!(!has_shot_number("| 12 | 8秒 |", 1));
}

/// Resume a captured interrupted task only inside its explicitly prepared backup.
/// Fixture preparation restores test-only lifecycle state; production terminal
/// transitions remain immutable. No source project is opened by this test.
#[test]
#[ignore = "Requires an isolated captured-task backup and explicit real-provider environment"]
fn context_management_real_captured_task_resume() {
    let directory = PathBuf::from(
        std::env::var("AI_VIDEO_CONTEXT_E2E_APP_DATA_DIR").expect("isolated settings directory"),
    );
    let fixture: Value = serde_json::from_slice(
        &std::fs::read(directory.join("captured-task.json")).expect("captured task fixture"),
    )
    .unwrap();
    let root = PathBuf::from(fixture["projectRoot"].as_str().unwrap());
    assert!(root
        .canonicalize()
        .unwrap()
        .starts_with(directory.canonicalize().unwrap()));
    let state = WorkerState::new(directory.clone()).unwrap();
    let mut serial = 0;
    let mut call = |method: &str, params: Value| -> Value {
        serial += 1;
        let value = state.request(&json!({"id":format!("captured-{serial}"),"protocolVersion":1,"method":method,"params":params})).expect("Worker response");
        assert_eq!(value["ok"], true, "{method}: {value}");
        value["result"].clone()
    };
    call("project.open", json!({"rootPath":root}));
    let started = Instant::now();
    let deadline = std::env::var("AI_VIDEO_CONTEXT_E2E_TIMEOUT_SECONDS")
        .ok()
        .map(|v| v.parse::<u64>().unwrap())
        .unwrap_or(1200);
    loop {
        let generation = call(
            "llm.generation.get",
            json!({"generationId":fixture["generationId"]}),
        );
        let task = call("agent.task.get", json!({"taskId":fixture["taskId"]}));
        let report = json!({"elapsedSeconds":started.elapsed().as_secs(),"generation":generation,"task":task});
        std::fs::write(
            directory.join("captured-live-report.json"),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
        let status = generation["status"].as_str().unwrap();
        assert!(
            !["failed", "cancelled"].contains(&status),
            "Captured task failed; see {}",
            directory.display()
        );
        if status == "complete" {
            assert_eq!(task["task"]["status"], "completed");
            assert_ne!(task["task"]["completionState"], "partial");
            let documents = call("document.list", json!({}));
            let shots = call("shot.list", json!({"sceneId":fixture["sceneId"]}));
            let ids = |rows: &Value| -> std::collections::BTreeSet<String> {
                rows.as_array()
                    .unwrap()
                    .iter()
                    .map(|r| r["id"].as_str().unwrap().to_string())
                    .collect()
            };
            let expected = |field: &str| -> std::collections::BTreeSet<String> {
                fixture[field]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|id| id.as_str().unwrap().to_string())
                    .collect()
            };
            assert_eq!(
                ids(&documents),
                expected(if fixture["listedDocumentIds"].is_array() {
                    "listedDocumentIds"
                } else {
                    "documentIds"
                }),
                "Saved documents must not be recreated"
            );
            assert_eq!(
                ids(&shots),
                expected("shotIds"),
                "Saved shots must not be recreated"
            );
            let prompts = shots
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s["authoringIR"]["prompt"].as_str().unwrap())
                .collect::<Vec<_>>()
                .join("\n");
            for required in fixture["requiredTexts"].as_array().unwrap() {
                assert!(
                    prompts.contains(required.as_str().unwrap()),
                    "Missing required source text: {required}"
                );
            }
            if let Some(unique) = fixture["uniqueTexts"].as_array() {
                for text in unique {
                    let count = shots
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|s| {
                            s["authoringIR"]["prompt"]
                                .as_str()
                                .unwrap()
                                .contains(text.as_str().unwrap())
                        })
                        .count();
                    assert_eq!(count, 1, "Dialogue must belong to exactly one shot: {text}");
                }
            }
            std::fs::write(
                directory.join("captured-acceptance.json"),
                serde_json::to_vec_pretty(
                    &json!({"report":report,"documents":documents,"shots":shots}),
                )
                .unwrap(),
            )
            .unwrap();
            break;
        }
        if started.elapsed() > Duration::from_secs(deadline) {
            state.shutdown();
            panic!(
                "Captured-task observation deadline; checkpoint retained at {}",
                directory.display()
            );
        }
        thread::sleep(Duration::from_secs(2));
    }
    state.shutdown();
}

/// Replay a captured real task against a SQLite backup inside the isolated test
/// directory. The original project is never opened or written by this harness.
#[test]
#[ignore = "Requires isolated real-task fixture and explicit real-provider acceptance environment"]
fn context_management_real_long_requirements() {
    let directory = PathBuf::from(
        std::env::var("AI_VIDEO_CONTEXT_E2E_APP_DATA_DIR").expect("isolated settings directory"),
    );
    let fixture: Value = serde_json::from_slice(
        &std::fs::read(directory.join("task-fixture.json")).expect("captured fixture"),
    )
    .unwrap();
    let root = PathBuf::from(fixture["projectRoot"].as_str().unwrap());
    assert!(root
        .canonicalize()
        .unwrap()
        .starts_with(directory.canonicalize().unwrap()));
    let profile = std::env::var("AI_VIDEO_CONTEXT_E2E_PROFILE").unwrap();
    let model = std::env::var("AI_VIDEO_CONTEXT_E2E_MODEL").unwrap();
    let prompt = fixture["prompt"].as_str().unwrap();
    assert!(
        prompt.chars().count() > 8500,
        "Must exercise the actual long-input failure"
    );
    let resumed_report: Option<Value> =
        if std::env::var("AI_VIDEO_CONTEXT_E2E_RESUME").as_deref() == Ok("1") {
            Some(
                serde_json::from_slice(&std::fs::read(directory.join("live-report.json")).unwrap())
                    .unwrap(),
            )
        } else {
            None
        };
    let state = WorkerState::new(directory.clone()).unwrap();
    let mut serial = 0;
    let mut call = |method: &str, params: Value| -> Value {
        serial += 1;
        let value = state.request(&json!({"id":format!("long-context-{serial}"),"protocolVersion":1,"method":method,"params":params})).expect("Worker response");
        assert_eq!(value["ok"], true, "{method}: {value}");
        value["result"].clone()
    };
    call("project.open", json!({"rootPath":root}));
    let before = fixture
        .get("baselineDocuments")
        .cloned()
        .unwrap_or_else(|| call("document.list", json!({})));
    let before_scenes = fixture
        .get("baselineScenes")
        .cloned()
        .unwrap_or_else(|| call("scene.list", json!({})));
    let mut before_shots = Vec::new();
    for scene in before_scenes.as_array().unwrap() {
        before_shots.extend(
            call("shot.list", json!({"sceneId":scene["id"]}))
                .as_array()
                .unwrap()
                .iter()
                .cloned(),
        );
    }
    let prepared = if let Some(report) = &resumed_report {
        json!({"stream":{"generationId":report["generation"]["generationId"]},"agentTaskId":report["task"]["task"]["id"]})
    } else {
        let conversation = call(
            "conversation.create",
            json!({"scopeType":"project","title":"现场长约束隔离验收"}),
        );
        let prepared = call(
            "agent.generation.prepare",
            json!({"conversationId":conversation["id"],"prompt":prompt,"providerProfileId":profile,"modelId":model,"agentMode":"document","researchMode":"network_disabled","productionSkillId":"script-to-media"}),
        );
        let mut start = prepared["stream"].clone();
        start["taskId"] = prepared["agentTaskId"].clone();
        start["mode"] = json!("document");
        start["prompt"] = json!(prompt);
        call("conversation.runtime.start", start);
        prepared
    };
    let generation = prepared["stream"]["generationId"].clone();
    let started = Instant::now();
    // This is an opt-in integration-test deadline, never an Agent execution budget.
    // Preserve a running task on expiry so the same generation can be resumed.
    let timeout_seconds = std::env::var("AI_VIDEO_CONTEXT_E2E_TIMEOUT_SECONDS")
        .ok()
        .map(|value| value.parse::<u64>().expect("positive test timeout seconds"))
        .unwrap_or(3600);
    assert!(timeout_seconds > 0, "positive test timeout seconds");
    let mut restarted = resumed_report.is_some();
    let mut saved_before_restart = if restarted {
        call("document.list", json!({}))
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| {
                !before
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|old| old["id"] == d["id"])
            })
            .cloned()
            .collect()
    } else {
        Vec::new()
    };
    loop {
        let current = call("llm.generation.get", json!({"generationId":generation}));
        let task = call("agent.task.get", json!({"taskId":prepared["agentTaskId"]}));
        std::fs::write(directory.join("live-report.json"), serde_json::to_vec_pretty(&json!({"elapsedSeconds":started.elapsed().as_secs(),"generation":current,"task":task,"projectRoot":root,"workerRestarted":restarted})).unwrap()).unwrap();
        let status = current["status"].as_str().unwrap_or_default();
        assert!(
            !["failed", "cancelled"].contains(&status),
            "Long-input task failed; evidence at {}",
            directory.display()
        );
        if !restarted && status == "streaming" {
            let documents = call("document.list", json!({}));
            let saved: Vec<Value> = documents
                .as_array()
                .unwrap()
                .iter()
                .filter(|d| {
                    !before.as_array().unwrap().iter().any(|old| {
                        old["id"] == d["id"] && old["currentVersionId"] == d["currentVersionId"]
                    })
                })
                .cloned()
                .collect();
            if !saved.is_empty() {
                saved_before_restart = saved;
                if let Some(worker) = state.process.lock().unwrap().take() {
                    worker
                        .child
                        .lock()
                        .unwrap()
                        .kill()
                        .expect("kill isolated test Worker");
                    worker
                        .child
                        .lock()
                        .unwrap()
                        .wait()
                        .expect("reap isolated test Worker");
                }
                restarted = true;
                call("project.open", json!({"rootPath":root}));
            }
        }
        if status == "complete" {
            let documents = call("document.list", json!({}));
            let scenes = call("scene.list", json!({}));
            let new_documents: Vec<_> = documents
                .as_array()
                .unwrap()
                .iter()
                .filter(|d| {
                    !before
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|old| old["id"] == d["id"])
                })
                .collect();
            let mut shots = Vec::new();
            for scene in scenes.as_array().unwrap() {
                shots.extend(
                    call("shot.list", json!({"sceneId":scene["id"]}))
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|shot| {
                            !before_shots.iter().any(|old| {
                                old["id"] == shot["id"] && old["rowVersion"] == shot["rowVersion"]
                            })
                        })
                        .cloned(),
                );
            }
            let changed_scenes: Vec<_> = scenes
                .as_array()
                .unwrap()
                .iter()
                .filter(|scene| {
                    !before_scenes.as_array().unwrap().iter().any(|old| {
                        old["id"] == scene["id"] && old["rowVersion"] == scene["rowVersion"]
                    }) || shots.iter().any(|shot| shot["sceneId"] == scene["id"])
                })
                .collect();
            let mut details = Vec::new();
            for document in &new_documents {
                details.push(call("document.get", json!({"documentId":document["id"]})));
            }
            std::fs::write(directory.join("acceptance-summary.json"), serde_json::to_vec_pretty(&json!({"generationId":generation,"elapsedSeconds":started.elapsed().as_secs(),"task":task,"newDocuments":new_documents,"documentDetails":details,"scenes":changed_scenes,"shots":shots,"workerRestarted":restarted,"savedBeforeRestart":saved_before_restart})).unwrap()).unwrap();
            assert_ne!(task["task"]["completionState"], "partial");
            assert!(!new_documents.is_empty(), "Must save production drafts");
            assert!(
                restarted,
                "Must exercise long-input recovery after a saved artifact"
            );
            // Existing episode shots must be updated in place. Physical scene row
            // counts cannot require duplicating a previously saved structure.
            let narrative = shots
                .iter()
                .filter_map(|shot| shot["authoringIR"]["prompt"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            for required in [
                "檐下",
                "钱箱",
                "蒙面",
                "阿诚",
                "凭据",
                "工棚",
                "左手",
                "那就不去县衙",
            ] {
                assert!(narrative.contains(required), "All four source scene intentions and original dialogue must survive: {required}");
            }
            assert!(
                shots.len() > 4,
                "Must save complete shot prompts and references"
            );
            for dialogue in [
                "还要多久？",
                "过了前头石桥，再走半里。",
                "桥边有人。",
                "你看见了？",
                "没看见。水声里多了两下桨声。",
                "箱子留下，人走。",
                "箱子里是工钱。你们拿走，明日盐场就会有人找。",
                "那是明日的事。",
                "不是来抢钱的。",
                "我不拿你的东西。",
                "不能去县衙。",
                "他们会说我偷了盐。",
                "那就不去县衙。",
                "你叫什么？",
                "阿诚。",
                "谁让你拿着这张凭据？",
            ] {
                assert!(
                    narrative.contains(dialogue),
                    "Original dialogue: {dialogue}"
                );
            }
            for required_prop in ["钱箱", "凭据"] {
                let prop_ids: Vec<_> = documents
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|d| {
                        d["kind"] == "prop" && d["title"].as_str().unwrap().contains(required_prop)
                    })
                    .map(|d| d["id"].clone())
                    .collect();
                assert!(
                    !prop_ids.is_empty(),
                    "Required independent prop: {required_prop}"
                );
                assert!(
                    shots.iter().any(|shot| {
                        shot["authoringIR"]["references"]["propDocumentIds"]
                            .as_array()
                            .is_some_and(|ids| ids.iter().any(|id| prop_ids.contains(id)))
                    }),
                    "Required prop must have a real shot binding: {required_prop}"
                );
            }
            for required_character in ["沈砚舟", "老汉", "蒙面", "阿诚"] {
                let character_ids: Vec<_> = documents
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|d| {
                        d["kind"] == "character"
                            && d["title"].as_str().unwrap().contains(required_character)
                    })
                    .map(|d| d["id"].clone())
                    .collect();
                assert!(
                    !character_ids.is_empty(),
                    "Every on-screen source character needs a saved production document: {required_character}"
                );
                assert!(
                    shots.iter().any(|shot| {
                        shot["authoringIR"]["references"]["characterDocumentIds"]
                            .as_array()
                            .is_some_and(|ids| ids.iter().any(|id| character_ids.contains(id)))
                    }),
                    "Every on-screen source character needs a real shot binding: {required_character}"
                );
            }
            for detail in details {
                assert!(
                    detail["currentVersion"]["contentMarkdown"]
                        .as_str()
                        .unwrap()
                        .chars()
                        .count()
                        > 100
                );
                assert!(detail["document"]["publishedVersionId"].is_null());
            }
            for shot in shots {
                let ir = &shot["authoringIR"];
                assert!(ir.is_object(), "complete shot authoring IR");
                assert!(ir["prompt"].as_str().unwrap().chars().count() > 100);
                for key in [
                    "characterDocumentIds",
                    "sceneDocumentIds",
                    "propDocumentIds",
                ] {
                    assert!(
                        ir["references"][key].is_array(),
                        "Complete per-shot reference lists"
                    );
                    let kind = match key {
                        "characterDocumentIds" => "character",
                        "sceneDocumentIds" => "scene",
                        _ => "prop",
                    };
                    for id in ir["references"][key].as_array().unwrap() {
                        assert!(
                            documents
                                .as_array()
                                .unwrap()
                                .iter()
                                .any(|d| { d["id"] == *id && d["kind"] == kind }),
                            "Reference must identify a real document of the correct kind: {id}"
                        );
                    }
                }
                assert!(ir["timing"]["estimatedDurationSeconds"].as_f64().unwrap() > 0.0);
                assert!(
                    ir["timing"]["beats"]
                        .as_array()
                        .is_some_and(|beats| !beats.is_empty()),
                    "Every shot needs saved natural action/dialogue timing"
                );
            }
            break;
        }
        if started.elapsed() > Duration::from_secs(timeout_seconds) {
            panic!(
                "Long-input acceptance deadline exceeded; task was not cancelled and can resume; evidence at {}",
                directory.display()
            );
        }
        thread::sleep(Duration::from_secs(2));
    }
}

#[test]
#[ignore = "Requires explicit real-provider acceptance environment and may incur text-model charges"]
fn context_management_real_episode_with_worker_restart() {
    run_real_episode_acceptance(false);
}

#[test]
#[ignore = "Requires isolated real-provider acceptance and may incur text-model charges"]
fn context_management_real_structured_review_with_worker_restart() {
    run_real_episode_acceptance(true);
}

fn run_real_episode_acceptance(structured: bool) {
    let directory = PathBuf::from(
        std::env::var("AI_VIDEO_CONTEXT_E2E_APP_DATA_DIR")
            .expect("isolated settings directory required"),
    );
    let profile = std::env::var("AI_VIDEO_CONTEXT_E2E_PROFILE").expect("provider ID required");
    let model = std::env::var("AI_VIDEO_CONTEXT_E2E_MODEL").expect("model ID required");
    assert!(directory.is_absolute() && directory.join("app-settings.sqlite").is_file());
    let state = WorkerState::new(directory.clone()).expect("native Worker host");
    let mut serial = 0;
    let mut call = |method: &str, params: Value| -> Value {
        serial += 1;
        let value=state.request(&json!({"id":format!("context-e2e-{serial}"),"protocolVersion":1,"method":method,"params":params})).expect("Worker response");
        assert_eq!(value["ok"], true, "{method}: {value}");
        value["result"].clone()
    };
    let root = directory.join(if structured {
        "structured-project"
    } else {
        "episode-project"
    });
    let resume_identity: Option<Value> = if std::env::var("AI_VIDEO_CONTEXT_E2E_RESUME").as_deref()
        == Ok("1")
    {
        assert!(root
            .canonicalize()
            .unwrap()
            .starts_with(directory.canonicalize().unwrap()));
        Some(
            serde_json::from_slice(&std::fs::read(directory.join("resume-identity.json")).unwrap())
                .unwrap(),
        )
    } else {
        None
    };
    if resume_identity.is_some() {
        call("project.open", json!({"rootPath":root}));
    } else {
        call(
            "project.create",
            json!({"rootPath":root,"name":"Context real episode acceptance"}),
        );
        call(
            "novel.import",
            json!({"chapters":[{"title":"雨夜重逢","displayLabel":"第一章","contentMarkdown":"雨夜，旧码头。林澈穿蓝色外套，手握一枚旧船票。周岚站在灯塔下等他。林澈说：我回来了。周岚说：我一直在等你。两人望向海面，远处传来汽笛声。"}]}),
        );
        call(
            "document.save",
            json!({"kind":"character","title":"林澈与周岚人物资料","contentMarkdown":"林澈，青年，蓝色外套，沉静。周岚，青年女性，灰色风衣。两人久别重逢，无第三人出场。"}),
        );
        call(
            "document.save",
            json!({"kind":"scene","title":"旧码头场景资料","contentMarkdown":"旧码头雨夜，湿木板、灯塔、海面、远处汽笛。全片遵守雨夜和灯塔空间连续性。"}),
        );
    }
    let prompt="生成一整集60秒微短剧所需的全部分镜提示词，共6镜。先按需读取《雨夜重逢》小说章节、人物和场景资料，再分析剧情、生成分镜、生成逐镜视频提示词、检查并保存。林澈必须穿蓝衣，逐字保留两句对白‘我回来了。’‘我一直在等你。’，禁止新增人物。先将剧情分析完整保存为标题《第1集剧情分析》的plan草稿，然后通过conversation.task.checkpoint save记录交接；之后保存《第1集分镜》和《第1集完整分镜提示词》两份plan草稿，每镜包含景别、动作、运镜、时长和对白，检查总时长60秒和全部要求。所有结果必须真正保存。一次自主完成，不生成图片/视频、不联网、不要求点击继续。若Worker中断，沿用已保存资料和回执继续，禁止重复保存已完成的文档。";
    let prompt = if structured {
        format!("{prompt}\n同时将这一集保存为真实场次和6个镜头，不仅是计划文档。逐镜保存完整视频提示词、三类真实资料引用和自然时长/节拍，总时长60秒。需要独立人物、场景和旧船票道具提示词资料。完成前读取当前全部产物，与原文及用户要求比较；用conversation.task.checkpoint operation=review和Worker提供的reviewId提交语义审查。按reviewScope复核，并用reviewedTargetIds明确本次真正审查的目标；未审查目标不能默认通过，必须比较已保存计划与真实镜头。内容问题需targetId及原文依据；修复后按issueId显式解决，有依据的误报可以撤回。缺读和版本就绪由Worker管理，不得登记为正文问题。")
    } else {
        prompt.to_string()
    };
    let prepared = if let Some(identity) = &resume_identity {
        json!({"stream":{"generationId":identity["generationId"]},"agentTaskId":identity["taskId"]})
    } else {
        let conversation = call("conversation.create", json!({"scopeType":"project"}));
        let mut parameters = json!({"conversationId":conversation["id"],"prompt":prompt,"providerProfileId":profile,"modelId":model,"agentMode":"document","researchMode":"network_disabled"});
        if structured {
            parameters["productionSkillId"] = json!("script-to-media");
        }
        let prepared = call("agent.generation.prepare", parameters);
        let mut start = prepared["stream"].clone();
        start["taskId"] = prepared["agentTaskId"].clone();
        start["mode"] = json!("document");
        start["prompt"] = json!(prompt);
        call("conversation.runtime.start", start);
        prepared
    };
    let generation = prepared["stream"]["generationId"].clone();
    let started = Instant::now();
    std::fs::write(
        directory.join("run-identity.json"),
        serde_json::to_vec_pretty(&json!({
            "generationId": generation,
            "taskId": prepared["agentTaskId"],
            "projectRoot": root,
            "prompt": prompt,
            "structured": structured,
        }))
        .unwrap(),
    )
    .unwrap();
    let prior_elapsed = resume_identity
        .as_ref()
        .and_then(|i| i["priorElapsedSeconds"].as_u64())
        .unwrap_or(0);
    let mut restarted = resume_identity.is_some();
    let mut saved_before = resume_identity
        .as_ref()
        .and_then(|i| i["analysisIds"].as_array())
        .cloned()
        .unwrap_or_default();
    loop {
        let current = call("llm.generation.get", json!({"generationId":generation}));
        std::fs::write(directory.join("live-report.json"),serde_json::to_vec_pretty(&json!({"elapsedSeconds":started.elapsed().as_secs(),"totalElapsedSeconds":prior_elapsed+started.elapsed().as_secs(),"resumedAfterFix":resume_identity.is_some(),"workerRestarted":restarted,"generation":current,"projectRoot":root})).unwrap()).unwrap();
        let status = current["status"].as_str().unwrap_or_default();
        assert!(
            !["failed", "cancelled"].contains(&status),
            "Real business task ended: {}",
            current
        );
        let documents = call("document.list", json!({}));
        let rows = documents.as_array().expect("document list");
        if !restarted && rows.iter().any(|d| d["title"] == "第1集剧情分析") && status != "complete"
        {
            let running_task = call("agent.task.get", json!({"taskId":prepared["agentTaskId"]}));
            assert!(
                running_task["resourceChanges"]["documentSequence"]
                    .as_u64()
                    .unwrap_or(0)
                    > 0,
                "Saved documents must expose committed changes while running"
            );
            saved_before = rows
                .iter()
                .filter(|d| d["title"] == "第1集剧情分析")
                .map(|d| d["id"].clone())
                .collect();
            // Kill the actual Node Worker without a graceful cancellation or final checkpoint.
            if let Some(worker) = state.process.lock().unwrap().take() {
                worker
                    .child
                    .lock()
                    .unwrap()
                    .kill()
                    .expect("kill test Worker");
                worker
                    .child
                    .lock()
                    .unwrap()
                    .wait()
                    .expect("reap test Worker");
            }
            restarted = true;
            call("project.open", json!({"rootPath":root}));
        }
        if status == "complete" {
            assert!(restarted, "Task finished before restart injection");
            let task = call("agent.task.get", json!({"taskId":prepared["agentTaskId"]}));
            assert_ne!(
                task["task"]["completionState"], "partial",
                "Business completion must not be partial"
            );
            for title in ["第1集剧情分析", "第1集分镜", "第1集完整分镜提示词"] {
                let matches: Vec<_> = rows.iter().filter(|d| d["title"] == title).collect();
                assert_eq!(matches.len(), 1, "Saved once: {title}");
                if title == "第1集剧情分析" {
                    assert!(saved_before.contains(&matches[0]["id"]));
                }
                let detail = call("document.get", json!({"documentId":matches[0]["id"]}));
                std::fs::write(
                    directory.join(format!("{title}.json")),
                    serde_json::to_vec_pretty(&detail).unwrap(),
                )
                .unwrap();
                let text = detail["currentVersion"]["contentMarkdown"]
                    .as_str()
                    .expect("saved full document");
                assert!(text.contains("蓝"));
                if title != "第1集剧情分析" {
                    for number in 1..=6 {
                        assert!(
                            has_shot_number(text, number),
                            "Missing shot {number}: {title}"
                        );
                    }
                    if !structured {
                        assert!(text.contains("60秒") || text.contains("60 秒"));
                    }
                }
                if title == "第1集完整分镜提示词" {
                    assert!(text.contains("我回来了") && text.contains("我一直在等你"));
                }
            }
            let mut final_shots = Vec::new();
            if structured {
                let scenes = call("scene.list", json!({}));
                for scene in scenes.as_array().unwrap() {
                    final_shots.extend(
                        call("shot.list", json!({"sceneId":scene["id"]}))
                            .as_array()
                            .unwrap()
                            .iter()
                            .cloned(),
                    );
                }
                assert_eq!(
                    final_shots.len(),
                    6,
                    "Exactly six persisted structured shots"
                );
                let duration: f64 = final_shots
                    .iter()
                    .map(|s| {
                        s["authoringIR"]["timing"]["estimatedDurationSeconds"]
                            .as_f64()
                            .unwrap()
                    })
                    .sum();
                assert!(
                    (duration - 60.0).abs() < 0.01,
                    "Saved shot timing must total 60 seconds"
                );
                let text = final_shots
                    .iter()
                    .map(|s| s["authoringIR"]["prompt"].as_str().unwrap())
                    .collect::<Vec<_>>()
                    .join("\n");
                assert!(
                    text.contains("蓝")
                        && text.contains("我回来了")
                        && text.contains("我一直在等你")
                );
                for shot in &final_shots {
                    for key in [
                        "characterDocumentIds",
                        "sceneDocumentIds",
                        "propDocumentIds",
                    ] {
                        assert!(
                            shot["authoringIR"]["references"][key].is_array(),
                            "Explicit saved reference lists"
                        );
                    }
                }
            }
            std::fs::write(directory.join("acceptance-summary.json"), serde_json::to_vec_pretty(&json!({"generationId":generation,"elapsedSeconds":started.elapsed().as_secs(),"totalElapsedSeconds":prior_elapsed+started.elapsed().as_secs(),"resumedAfterFix":resume_identity.is_some(),"workerRestarted":restarted,"task":task,"documents":rows,"shots":final_shots,"structured":structured})).unwrap()).unwrap();
            break;
        }
        if started.elapsed() > Duration::from_secs(1200) {
            state.shutdown();
            panic!(
                "Real acceptance exceeded 20 minutes; task paused with evidence retained at {}",
                directory.display()
            );
        }
        thread::sleep(Duration::from_secs(2));
    }
}
