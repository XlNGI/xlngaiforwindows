use std::{
    collections::HashMap,
    fs::File,
    io::{Cursor, Read},
    path::Path,
};

use encoding_rs::GB18030;
use roxmltree::{Document, Node, ParsingOptions};
use serde::Serialize;
use zip::ZipArchive;

use crate::read_markdown_document;

/// Plain-text (`.txt`) novel files can exceed the 5 MiB Markdown import cap; 32 MiB aligns with
/// the Worker's total novel-import budget.
pub const TEXT_IMPORT_LIMIT: u64 = 32 * 1024 * 1024;
/// EPUB files commonly embed cover images and chapter artwork, so the archive itself may be much
/// larger than the extracted text.
pub const EPUB_IMPORT_LIMIT: u64 = 64 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelImportResult {
    pub title: String,
    pub content_markdown: String,
}

pub fn read_novel_document(path: &Path) -> Result<NovelImportResult, String> {
    if !path.is_absolute() {
        return Err("Novel import path must be absolute".to_string());
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase());
    match extension.as_deref() {
        Some("md") | Some("markdown") => {
            let imported = read_markdown_document(path)?;
            Ok(NovelImportResult {
                title: imported.title,
                content_markdown: imported.content_markdown,
            })
        }
        Some("txt") => read_txt_document(path),
        Some("epub") => read_epub_document(path),
        _ => Err("Only .md, .markdown, .txt and .epub files can be imported".to_string()),
    }
}

#[tauri::command]
pub fn novel_import(path: String) -> Result<NovelImportResult, String> {
    read_novel_document(Path::new(&path))
}

fn read_txt_document(path: &Path) -> Result<NovelImportResult, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Could not open text file: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect text file: {error}"))?;
    if !metadata.is_file() {
        return Err("Text import path must identify a file".to_string());
    }
    if metadata.len() > TEXT_IMPORT_LIMIT {
        return Err("Text file exceeds the 32 MiB import limit".to_string());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read text file: {error}"))?;
    if bytes.len() as u64 > TEXT_IMPORT_LIMIT {
        return Err("Text file exceeds the 32 MiB import limit".to_string());
    }
    Ok(NovelImportResult {
        title: file_title(path)?,
        content_markdown: decode_novel_text(&bytes)?,
    })
}

/// Decodes downloaded novel text. Most plain-text novels are UTF-8, UTF-16 with a BOM, or legacy
/// GBK/GB2312 encodings common on Chinese download sites, so strict UTF-8 is tried first and
/// GB18030 (a superset of GBK/GB2312) is used as a fallback.
fn decode_novel_text(bytes: &[u8]) -> Result<String, String> {
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return String::from_utf8(bytes[3..].to_vec())
            .map_err(|_| "Text files must use a supported encoding".to_string());
    }
    if bytes.starts_with(&[0xff, 0xfe]) {
        return decode_utf16(&bytes[2..], true);
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        return decode_utf16(&bytes[2..], false);
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok(text.to_string());
    }
    let (decoded, _, _) = GB18030.decode(bytes);
    Ok(decoded.into_owned())
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> Result<String, String> {
    let units = bytes
        .chunks_exact(2)
        .map(|chunk| {
            if little_endian {
                u16::from_le_bytes([chunk[0], chunk[1]])
            } else {
                u16::from_be_bytes([chunk[0], chunk[1]])
            }
        })
        .collect::<Vec<u16>>();
    String::from_utf16(&units).map_err(|_| "Text files must use a supported encoding".to_string())
}

fn read_epub_document(path: &Path) -> Result<NovelImportResult, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Could not open EPUB file: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect EPUB file: {error}"))?;
    if !metadata.is_file() {
        return Err("EPUB import path must identify a file".to_string());
    }
    if metadata.len() > EPUB_IMPORT_LIMIT {
        return Err("EPUB file exceeds the 64 MiB import limit".to_string());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read EPUB file: {error}"))?;
    if bytes.len() as u64 > EPUB_IMPORT_LIMIT {
        return Err("EPUB file exceeds the 64 MiB import limit".to_string());
    }

    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("EPUB is not a valid zip archive: {error}"))?;
    let container_xml = read_zip_text(&mut archive, "META-INF/container.xml")?;
    let opf_path = parse_container(&container_xml)?;
    let opf_xml = read_zip_text(&mut archive, &opf_path)?;
    let package = parse_opf(&opf_xml)?;
    let opf_dir = Path::new(&normalize_zip_path(&opf_path))
        .parent()
        .map(|parent| parent.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();

    let mut content = String::new();
    let mut chapter_count = 0usize;
    for idref in &package.spine {
        let Some((href, media_type)) = package.manifest.get(idref) else {
            continue;
        };
        if let Some(media_type) = media_type.as_deref() {
            if !media_type.contains("html") {
                continue;
            }
        }
        let entry = resolve_zip_entry(&opf_dir, href);
        let Ok(xhtml) = read_zip_text(&mut archive, &entry) else {
            continue;
        };
        let mut markdown = xhtml_to_markdown(&xhtml);
        if markdown.is_empty() {
            continue;
        }
        if !markdown.starts_with('#') {
            let title = xhtml_head_title(&xhtml)
                .filter(|title| !title.trim().is_empty())
                .map(|title| title.trim().to_string())
                .unwrap_or_else(|| format!("第 {} 章", chapter_count + 1));
            markdown = format!("# {title}\n\n{markdown}");
        }
        content.push_str(markdown.trim_end());
        content.push_str("\n\n");
        chapter_count += 1;
    }
    if chapter_count == 0 {
        return Err("EPUB does not contain any readable chapters".to_string());
    }
    Ok(NovelImportResult {
        title: package
            .title
            .filter(|title| !title.trim().is_empty())
            .map(|title| title.trim().to_string())
            .unwrap_or(file_title(path)?),
        content_markdown: content.trim().to_string(),
    })
}

fn parse_container(xml: &str) -> Result<String, String> {
    let document = Document::parse(xml)
        .map_err(|error| format!("EPUB container.xml is not valid XML: {error}"))?;
    document
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == "rootfile")
        .and_then(|node| node.attribute("full-path"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "EPUB container.xml does not declare a root file".to_string())
}

struct OpfPackage {
    title: Option<String>,
    manifest: HashMap<String, (String, Option<String>)>,
    spine: Vec<String>,
}

fn parse_opf(xml: &str) -> Result<OpfPackage, String> {
    let document = Document::parse(xml)
        .map_err(|error| format!("EPUB package file is not valid XML: {error}"))?;
    let title = document
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == "metadata")
        .and_then(|metadata| {
            metadata
                .descendants()
                .find(|node| node.is_element() && node.tag_name().name() == "title")
        })
        .and_then(|title| title.text())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let mut manifest = HashMap::new();
    for item in document
        .descendants()
        .filter(|node| node.is_element() && node.tag_name().name() == "item")
    {
        if let (Some(id), Some(href)) = (item.attribute("id"), item.attribute("href")) {
            let media_type = item.attribute("media-type").map(str::to_string);
            manifest.insert(id.to_string(), (href.to_string(), media_type));
        }
    }

    let spine = document
        .descendants()
        .filter(|node| node.is_element() && node.tag_name().name() == "itemref")
        .filter_map(|node| node.attribute("idref"))
        .map(str::to_string)
        .collect();

    Ok(OpfPackage {
        title,
        manifest,
        spine,
    })
}

fn read_zip_text(archive: &mut ZipArchive<Cursor<Vec<u8>>>, name: &str) -> Result<String, String> {
    let entry_name =
        find_entry_name(archive, name).ok_or_else(|| format!("EPUB is missing {name}"))?;
    let mut file = archive
        .by_name(&entry_name)
        .map_err(|error| format!("Could not read EPUB file {name}: {error}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read EPUB file {name}: {error}"))?;
    if let Ok(text) = std::str::from_utf8(&bytes) {
        return Ok(text.to_string());
    }
    let (decoded, _, _) = GB18030.decode(&bytes);
    Ok(decoded.into_owned())
}

fn find_entry_name(archive: &mut ZipArchive<Cursor<Vec<u8>>>, name: &str) -> Option<String> {
    let normalized = normalize_zip_path(name);
    for index in 0..archive.len() {
        if let Ok(entry) = archive.by_index(index) {
            let entry_name = entry.name().to_string();
            let entry_normalized = normalize_zip_path(&entry_name);
            if entry_normalized == normalized || entry_normalized.eq_ignore_ascii_case(&normalized)
            {
                return Some(entry_name);
            }
        }
    }
    None
}

fn normalize_zip_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    parts.join("/")
}

fn resolve_zip_entry(base_dir: &str, href: &str) -> String {
    if base_dir.is_empty() {
        normalize_zip_path(href)
    } else {
        normalize_zip_path(&format!("{base_dir}/{href}"))
    }
}

fn xhtml_to_markdown(xml: &str) -> String {
    let document = match parse_xhtml(xml) {
        Some(document) => document,
        None => return String::new(),
    };
    let mut out = String::new();
    render_blocks(&document.root_element(), &mut out);
    out.trim().to_string()
}

fn xhtml_head_title(xml: &str) -> Option<String> {
    let document = parse_xhtml(xml)?;
    document
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == "title")
        .and_then(|node| node.text())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn parse_xhtml(xml: &str) -> Option<Document<'_>> {
    Document::parse_with_options(
        xml,
        ParsingOptions {
            allow_dtd: true,
            ..ParsingOptions::default()
        },
    )
    .ok()
}

fn render_blocks(node: &Node, out: &mut String) {
    for child in node.children() {
        if child.is_element() {
            render_element(&child, out);
        } else if child.is_text() {
            if let Some(text) = child.text() {
                if !text.trim().is_empty() {
                    out.push_str(text.trim());
                    out.push_str("\n\n");
                }
            }
        }
    }
}

fn render_element(node: &Node, out: &mut String) {
    let name = node.tag_name().name();
    match name {
        "script" | "style" | "head" | "nav" | "title" | "link" | "meta" | "xml" => {}
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            let level = name.as_bytes()[1] - b'0';
            let text = inline_text(node);
            if !text.trim().is_empty() {
                out.push_str(&"#".repeat(level as usize));
                out.push(' ');
                out.push_str(text.trim());
                out.push_str("\n\n");
            }
        }
        "p" => {
            let text = inline_text(node);
            if !text.trim().is_empty() {
                out.push_str(text.trim());
                out.push_str("\n\n");
            }
        }
        "br" => out.push('\n'),
        "hr" => out.push_str("---\n\n"),
        "ul" | "ol" => render_list(node, out),
        "blockquote" => render_blockquote(node, out),
        "pre" => {
            let text = node.text().unwrap_or("");
            if !text.trim().is_empty() {
                out.push_str("```\n");
                out.push_str(text.trim_end());
                out.push_str("\n```\n\n");
            }
        }
        "div" | "section" | "article" | "main" | "body" | "html" | "figure" | "figcaption"
        | "center" | "header" | "footer" => render_blocks(node, out),
        "img" => {
            let alt = node.attribute("alt").unwrap_or("").trim();
            let src = node.attribute("src").unwrap_or("").trim();
            out.push_str(&format!("![{alt}]({src})\n\n"));
        }
        _ => {
            let text = inline_text(node);
            if !text.trim().is_empty() {
                out.push_str(text.trim());
                out.push_str("\n\n");
            } else {
                render_blocks(node, out);
            }
        }
    }
}

fn render_list(node: &Node, out: &mut String) {
    let mut items = Vec::new();
    for child in node.children() {
        if child.is_element() && child.tag_name().name() == "li" {
            let text = inline_text(&child);
            if !text.trim().is_empty() {
                items.push(text.trim().to_string());
            }
        }
    }
    if items.is_empty() {
        return;
    }
    out.push('\n');
    for item in items {
        out.push_str("- ");
        out.push_str(&item);
        out.push('\n');
    }
    out.push('\n');
}

fn render_blockquote(node: &Node, out: &mut String) {
    let mut inner = String::new();
    render_blocks(node, &mut inner);
    let inner = inner.trim();
    if inner.is_empty() {
        return;
    }
    for line in inner.lines() {
        out.push_str("> ");
        out.push_str(line);
        out.push('\n');
    }
    out.push('\n');
}

fn inline_text(node: &Node) -> String {
    let mut out = String::new();
    inline_render(node, &mut out);
    out
}

fn inline_render(node: &Node, out: &mut String) {
    if node.is_text() {
        out.push_str(&collapse_whitespace(node.text().unwrap_or("")));
        return;
    }
    if !node.is_element() {
        return;
    }
    let name = node.tag_name().name();
    match name {
        "br" => out.push('\n'),
        "strong" | "b" => {
            out.push_str("**");
            for child in node.children() {
                inline_render(&child, out);
            }
            out.push_str("**");
        }
        "em" | "i" => {
            out.push('*');
            for child in node.children() {
                inline_render(&child, out);
            }
            out.push('*');
        }
        "code" => {
            out.push('`');
            out.push_str(node.text().unwrap_or("").trim());
            out.push('`');
        }
        "a" => {
            let href = node.attribute("href").unwrap_or("").trim();
            let mut text = String::new();
            for child in node.children() {
                inline_render(&child, &mut text);
            }
            let text = text.trim().to_string();
            if !text.is_empty() {
                if href.is_empty() {
                    out.push_str(&text);
                } else {
                    out.push_str(&format!("[{text}]({href})"));
                }
            }
        }
        "img" => {
            let alt = node.attribute("alt").unwrap_or("").trim();
            let src = node.attribute("src").unwrap_or("").trim();
            out.push_str(&format!("![{alt}]({src})"));
        }
        _ => {
            for child in node.children() {
                inline_render(&child, out);
            }
        }
    }
}

fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut previous_was_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !previous_was_space {
                out.push(' ');
            }
            previous_was_space = true;
        } else {
            out.push(ch);
            previous_was_space = false;
        }
    }
    out
}

fn file_title(path: &Path) -> Result<String, String> {
    path.file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "File name cannot be used as a document title".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn fixture_dir(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "unicomp-novel-import-{label}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("create fixture directory");
        root
    }

    fn write_bytes(root: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = root.join(name);
        std::fs::write(&path, bytes).expect("write fixture");
        path
    }

    fn gbk_bytes(text: &str) -> Vec<u8> {
        let (bytes, _, _) = GB18030.encode(text);
        bytes.into_owned()
    }

    fn build_epub() -> Vec<u8> {
        let container = r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;
        let opf = r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>雾港纪事</dc:title>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="chapter1"/>
    <itemref idref="chapter2"/>
  </spine>
</package>"#;
        let chapter1 = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第一章</title></head>
<body><h1>第一章</h1><p>开端。</p></body>
</html>"#;
        let chapter2 = r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第二章</title></head>
<body><p>转折。<strong>重要</strong></p></body>
</html>"#;
        let files = [
            ("META-INF/container.xml", container),
            ("OEBPS/content.opf", opf),
            ("OEBPS/chapter1.xhtml", chapter1),
            ("OEBPS/chapter2.xhtml", chapter2),
        ];
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in files {
            writer.start_file(name, options).expect("start EPUB entry");
            writer
                .write_all(content.as_bytes())
                .expect("write EPUB entry");
        }
        let cursor = writer.finish().expect("finish EPUB archive");
        cursor.into_inner()
    }

    #[test]
    fn txt_import_decodes_utf8_gbk_and_utf16_and_rejects_unsafe_inputs() {
        let root = fixture_dir("txt");
        let utf8 = write_bytes(
            &root,
            "雾港纪事.txt",
            "\u{feff}第一章\n\n故事开始。".as_bytes(),
        );
        let imported = read_txt_document(&utf8).expect("import UTF-8 text");
        assert_eq!(imported.title, "雾港纪事");
        assert_eq!(imported.content_markdown, "第一章\n\n故事开始。");

        let gbk = write_bytes(
            &root,
            "雾港纪事-gbk.txt",
            &gbk_bytes("第一章\n\n故事开始。"),
        );
        let imported = read_txt_document(&gbk).expect("import GBK text");
        assert_eq!(imported.content_markdown, "第一章\n\n故事开始。");

        let mut utf16_bytes = vec![0xff, 0xfe];
        for unit in "第一章\n\n故事开始。".encode_utf16() {
            utf16_bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let utf16 = write_bytes(&root, "雾港纪事-utf16.txt", &utf16_bytes);
        let imported = read_txt_document(&utf16).expect("import UTF-16 text");
        assert_eq!(imported.content_markdown, "第一章\n\n故事开始。");

        let unsupported = write_bytes(&root, "notes.pdf", b"not a novel");
        assert!(read_novel_document(&unsupported).is_err());

        let oversized = root.join("oversized.txt");
        let oversized_file = std::fs::File::create(&oversized).expect("create oversized fixture");
        oversized_file
            .set_len(TEXT_IMPORT_LIMIT + 1)
            .expect("size oversized fixture");
        assert!(read_txt_document(&oversized).is_err());

        std::fs::remove_dir_all(root).expect("remove text fixture directory");
    }

    #[test]
    fn epub_import_reads_spine_in_order_and_uses_opf_title() {
        let root = fixture_dir("epub");
        let path = write_bytes(&root, "雾港纪事.epub", &build_epub());
        let imported = read_epub_document(&path).expect("import EPUB");
        assert_eq!(imported.title, "雾港纪事");
        assert_eq!(
            imported.content_markdown,
            "# 第一章\n\n开端。\n\n# 第二章\n\n转折。**重要**"
        );
        std::fs::remove_dir_all(root).expect("remove EPUB fixture directory");
    }

    #[test]
    fn epub_import_adds_fallback_heading_for_untitled_chapters() {
        let root = fixture_dir("epub-fallback");
        let container = r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;
        let opf = r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>雾港纪事</dc:title>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
    <itemref idref="chapter2"/>
  </spine>
</package>"#;
        let chapter1 =
            r#"<html xmlns="http://www.w3.org/1999/xhtml"><body><p>开端。</p></body></html>"#;
        let chapter2 =
            r#"<html xmlns="http://www.w3.org/1999/xhtml"><body><p>转折。</p></body></html>"#;
        let files = [
            ("META-INF/container.xml", container),
            ("OEBPS/content.opf", opf),
            ("OEBPS/chapter1.xhtml", chapter1),
            ("OEBPS/chapter2.xhtml", chapter2),
        ];
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in files {
            writer.start_file(name, options).expect("start EPUB entry");
            writer
                .write_all(content.as_bytes())
                .expect("write EPUB entry");
        }
        let cursor = writer.finish().expect("finish EPUB archive");
        let path = write_bytes(&root, "雾港纪事.epub", &cursor.into_inner());
        let imported = read_epub_document(&path).expect("import EPUB");
        assert_eq!(imported.title, "雾港纪事");
        assert_eq!(
            imported.content_markdown,
            "# 第 1 章

开端。

# 第 2 章

转折。"
        );
        std::fs::remove_dir_all(root).expect("remove EPUB fixture directory");
    }

    #[test]
    fn epub_import_rejects_invalid_archives() {
        let root = fixture_dir("epub-invalid");
        let not_zip = write_bytes(&root, "broken.epub", b"this is not a zip archive");
        assert!(read_epub_document(&not_zip).is_err());

        let empty = write_bytes(&root, "empty.epub", &[]);
        assert!(read_epub_document(&empty).is_err());
        std::fs::remove_dir_all(root).expect("remove invalid EPUB fixture directory");
    }

    #[test]
    fn xhtml_to_markdown_maps_common_elements() {
        let xml = r#"<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h2>标题</h2>
<p>正文 <strong>加粗</strong> 与 <a href="https://example.com">链接</a>。</p>
<ul><li>甲</li><li>乙</li></ul>
<blockquote><p>引用文本</p></blockquote>
</body></html>"#;
        let markdown = xhtml_to_markdown(xml);
        assert!(markdown.contains("## 标题"));
        assert!(markdown.contains("正文 **加粗** 与 [链接](https://example.com)。"));
        assert!(markdown.contains("- 甲\n- 乙"));
        assert!(markdown.contains("> 引用文本"));
    }

    #[test]
    fn normalize_zip_path_resolves_relative_segments() {
        assert_eq!(
            normalize_zip_path("OEBPS/../OEBPS/content.opf"),
            "OEBPS/content.opf"
        );
        assert_eq!(
            normalize_zip_path("OEBPS/./chapter1.xhtml"),
            "OEBPS/chapter1.xhtml"
        );
        assert_eq!(
            normalize_zip_path("OEBPS\\chapter1.xhtml"),
            "OEBPS/chapter1.xhtml"
        );
        assert_eq!(normalize_zip_path("chapter1.xhtml"), "chapter1.xhtml");
    }
}
