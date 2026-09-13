// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

// ──────────────────────────────────────────────
// 数据类型
// ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub name: String,
    pub definition: String,
    pub color: String,
    pub shortcut: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Annotations {
    pub rows: HashMap<String, Vec<String>>,
    pub cells: HashMap<String, HashMap<String, Vec<String>>>,
    pub columns: HashMap<String, Vec<String>>,
    pub dataset: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagsFile {
    pub version: u32,
    pub tags: HashMap<String, Tag>,
    pub annotations: Annotations,
}

impl Default for TagsFile {
    fn default() -> Self {
        Self {
            version: 1,
            tags: HashMap::new(),
            annotations: Annotations::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedData {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub row_count: usize,
    pub column_count: usize,
}

// ──────────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────────

fn tags_path(csv_path: &str) -> String {
    format!("{}.tags.json", csv_path)
}

fn load_tags(csv_path: &str) -> TagsFile {
    let path = tags_path(csv_path);
    if Path::new(&path).exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        TagsFile::default()
    }
}

fn save_tags(csv_path: &str, tags_file: &TagsFile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(tags_file).map_err(|e| e.to_string())?;
    std::fs::write(tags_path(csv_path), json).map_err(|e| e.to_string())
}

// ──────────────────────────────────────────────
// Tauri 命令
// ──────────────────────────────────────────────

#[tauri::command]
fn open_csv(path: String) -> Result<ParsedData, String> {
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = std::io::BufReader::new(file);

    let delimiter = if path.ends_with(".tsv") { b'\t' } else { b',' };

    let mut rdr = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(true)
        .from_reader(reader);

    let headers: Vec<String> = rdr
        .headers()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|s| s.to_string())
        .collect();

    let mut rows = Vec::new();
    for result in rdr.records() {
        let record = result.map_err(|e| e.to_string())?;
        rows.push(record.iter().map(|s| s.to_string()).collect::<Vec<String>>());
    }

    let row_count = rows.len();
    let column_count = headers.len();

    Ok(ParsedData {
        headers,
        rows,
        row_count,
        column_count,
    })
}

#[tauri::command]
fn save_csv(
    csv_path: String,
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
    delimiter: String,
) -> Result<(), String> {
    let delimiter = if delimiter == "\t" { b'\t' } else { b',' };
    let mut writer = csv::WriterBuilder::new()
        .delimiter(delimiter)
        .from_path(&csv_path)
        .map_err(|e| e.to_string())?;

    writer
        .write_record(headers.iter().map(String::as_str))
        .map_err(|e| e.to_string())?;
    for row in rows {
        writer
            .write_record(row.iter().map(String::as_str))
            .map_err(|e| e.to_string())?;
    }
    writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_workspace(
    csv_path: String,
    tags: HashMap<String, Tag>,
    annotations: Annotations,
) -> Result<(), String> {
    save_tags(&csv_path, &TagsFile { version: 1, tags, annotations })
}

#[tauri::command]
fn get_tags(csv_path: String) -> Vec<Tag> {
    let tf = load_tags(&csv_path);
    tf.tags.values().cloned().collect()
}

#[tauri::command]
fn get_annotations(csv_path: String) -> Annotations {
    let tf = load_tags(&csv_path);
    tf.annotations
}

#[tauri::command]
fn create_tag(
    csv_path: String,
    name: String,
    definition: String,
    color: String,
    shortcut: String,
) -> Result<(), String> {
    let mut tf = load_tags(&csv_path);
    tf.tags.insert(
        name.clone(),
        Tag {
            name,
            definition,
            color,
            shortcut,
        },
    );
    save_tags(&csv_path, &tf)
}

#[tauri::command]
fn update_tag(
    csv_path: String,
    old_name: String,
    name: String,
    definition: String,
    color: String,
    shortcut: String,
) -> Result<(), String> {
    let mut tf = load_tags(&csv_path);
    if old_name != name {
        tf.tags.remove(&old_name);
        let replace = |items: &mut Vec<String>| {
            for item in items.iter_mut() {
                if item == &old_name {
                    *item = name.clone();
                }
            }
        };
        for items in tf.annotations.rows.values_mut() {
            replace(items);
        }
        for items in tf.annotations.columns.values_mut() {
            replace(items);
        }
        for cells in tf.annotations.cells.values_mut() {
            for items in cells.values_mut() {
                replace(items);
            }
        }
        replace(&mut tf.annotations.dataset);
    }
    tf.tags.insert(name.clone(), Tag { name, definition, color, shortcut });
    save_tags(&csv_path, &tf)
}

#[tauri::command]
fn delete_tag(csv_path: String, name: String) -> Result<(), String> {
    let mut tf = load_tags(&csv_path);
    tf.tags.remove(&name);
    // 同时移除所有标注中的该标签
    for tags in tf.annotations.rows.values_mut() {
        tags.retain(|t| t != &name);
    }
    for cells in tf.annotations.cells.values_mut() {
        for tags in cells.values_mut() {
            tags.retain(|t| t != &name);
        }
    }
    for tags in tf.annotations.columns.values_mut() {
        tags.retain(|t| t != &name);
    }
    tf.annotations.dataset.retain(|t| t != &name);
    save_tags(&csv_path, &tf)
}

#[tauri::command]
fn annotate_row(csv_path: String, row_id: String, tag_name: String) -> Result<(), String> {
    let mut tf = load_tags(&csv_path);
    let entry = tf.annotations.rows.entry(row_id).or_default();
    if !entry.contains(&tag_name) {
        entry.push(tag_name);
    }
    save_tags(&csv_path, &tf)
}

#[tauri::command]
fn annotate_cell(
    csv_path: String,
    row_id: String,
    column: String,
    tag_name: String,
) -> Result<(), String> {
    let mut tf = load_tags(&csv_path);
    let row_entry = tf.annotations.cells.entry(row_id).or_default();
    let col_entry = row_entry.entry(column).or_default();
    if !col_entry.contains(&tag_name) {
        col_entry.push(tag_name);
    }
    save_tags(&csv_path, &tf)
}

#[tauri::command]
fn annotate_column(csv_path: String, column: String, tag_name: String) -> Result<(), String> {
    let mut tf = load_tags(&csv_path);
    let entry = tf.annotations.columns.entry(column).or_default();
    if !entry.contains(&tag_name) {
        entry.push(tag_name);
    }
    save_tags(&csv_path, &tf)
}

#[tauri::command]
fn annotate_dataset(csv_path: String, tag_name: String) -> Result<(), String> {
    let mut tf = load_tags(&csv_path);
    if !tf.annotations.dataset.contains(&tag_name) {
        tf.annotations.dataset.push(tag_name);
    }
    save_tags(&csv_path, &tf)
}

#[tauri::command]
fn remove_annotation(
    csv_path: String,
    annotation_type: String,
    target: String,
    tag_name: String,
) -> Result<(), String> {
    let mut tf = load_tags(&csv_path);
    match annotation_type.as_str() {
        "row" => {
            if let Some(tags) = tf.annotations.rows.get_mut(&target) {
                tags.retain(|t| t != &tag_name);
            }
        }
        "column" => {
            if let Some(tags) = tf.annotations.columns.get_mut(&target) {
                tags.retain(|t| t != &tag_name);
            }
        }
        "dataset" => {
            tf.annotations.dataset.retain(|t| t != &tag_name);
        }
        "cell" => {
            // target format: "row_id:column"
            if let Some((row_id, col)) = target.split_once(':') {
                if let Some(cells) = tf.annotations.cells.get_mut(row_id) {
                    if let Some(tags) = cells.get_mut(col) {
                        tags.retain(|t| t != &tag_name);
                    }
                }
            }
        }
        _ => {}
    }
    save_tags(&csv_path, &tf)
}

#[tauri::command]
fn export_for_ai(csv_path: String) -> Result<serde_json::Value, String> {
    let tf = load_tags(&csv_path);

    let mut annotations = Vec::new();

    for (row_id, tags) in &tf.annotations.rows {
        annotations.push(serde_json::json!({ "row_id": row_id, "tags": tags }));
    }
    for (row_id, cells) in &tf.annotations.cells {
        for (column, tags) in cells {
            annotations.push(serde_json::json!({ "row_id": row_id, "column": column, "tags": tags }));
        }
    }
    for (column, tags) in &tf.annotations.columns {
        annotations.push(serde_json::json!({ "column": column, "tags": tags }));
    }
    if !tf.annotations.dataset.is_empty() {
        annotations.push(serde_json::json!({ "dataset": true, "tags": tf.annotations.dataset }));
    }

    let tag_defs: serde_json::Value = tf
        .tags
        .iter()
        .map(|(name, tag)| {
            (
                name.clone(),
                serde_json::json!({ "definition": tag.definition }),
            )
        })
        .collect::<serde_json::Map<String, serde_json::Value>>()
        .into();

    Ok(serde_json::json!({
        "dataset": { "file": csv_path, "description": "" },
        "tag_definitions": tag_defs,
        "annotations": annotations
    }))
}

// ──────────────────────────────────────────────
// 入口
// ──────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            open_csv,
            save_csv,
            save_workspace,
            get_tags,
            get_annotations,
            create_tag,
            update_tag,
            delete_tag,
            annotate_row,
            annotate_cell,
            annotate_column,
            annotate_dataset,
            remove_annotation,
            export_for_ai,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
