/** UTF-8 only. A leading BOM is consumed; all other whitespace is retained. */
export async function readPromptTemplateFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>) {
  if (!/\.(txt|md|markdown)$/i.test(file.name))
    throw new Error('请选择 UTF-8 TXT 或 Markdown 模板。');
  if (file.size > 1024 * 1024) throw new Error('模板文件不能超过 1 MiB，请分用途整理后导入。');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new Error('文件不是有效的 UTF-8 文本，请转换编码后重新导入。');
  }
}
