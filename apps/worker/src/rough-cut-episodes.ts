/** Only explicit episode labels count; scene names and creation times do not infer membership. */
export function episodeNumber(title: string): number | undefined {
  const text = title.normalize('NFKC');
  const match = /第\s*([0-9一二三四五六七八九十百千万零〇两]+)\s*集/u.exec(text);
  if (!match) return undefined;
  const token = match[1]!;
  if (/^\d+$/.test(token)) {
    const number = Number(token);
    return Number.isSafeInteger(number) && number > 0 && number <= 99999 ? number : undefined;
  }
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (/^[零〇一二三四五六七八九]+$/u.test(token)) {
    const number = Number([...token].map((char) => digits[char]).join(''));
    return number > 0 && number <= 99999 ? number : undefined;
  }
  if (!/^[一二两三四五六七八九]?[十百千][零〇一二两三四五六七八九十百千]*$/u.test(token))
    return undefined;
  let total = 0;
  let digit = 0;
  for (const char of token) {
    const unit = ({ 十: 10, 百: 100, 千: 1000 } as Record<string, number>)[char];
    if (unit) {
      total += (digit || 1) * unit;
      digit = 0;
    } else digit = digits[char] ?? 0;
  }
  return total + digit || undefined;
}
