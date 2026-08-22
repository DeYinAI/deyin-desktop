//! Deyin's in-house native hot path. All algorithms implemented from scratch —
//! no third-party algorithm crates; napi is binding glue only.

pub mod compress;
pub mod grep;
pub mod sse;
pub mod tokenizer;

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Parse one SSE `data:` line.
/// Returns null for keep-alives/non-data lines, the string "[DONE]" sentinel is
/// signalled via `isDone`, otherwise `payload` holds raw JSON text (not parsed —
/// JSON parsing stays on the JS side where the objects are consumed).
#[napi(object)]
pub struct SseLineResult {
  pub payload: Option<String>,
  pub is_done: bool,
}

#[napi]
pub fn parse_sse_data_line(line: String) -> SseLineResult {
  match sse::parse_data_line(&line) {
    sse::LineOutcome::KeepAlive => SseLineResult { payload: None, is_done: false },
    sse::LineOutcome::Done => SseLineResult { payload: None, is_done: true },
    sse::LineOutcome::Payload(json) => SseLineResult { payload: Some(json), is_done: false },
  }
}

/// Frame a raw byte chunk into complete SSE data lines.
/// Returns the extracted payloads plus the trailing partial line to prepend
/// to the next chunk.
#[napi(object)]
pub struct SseChunkResult {
  pub payloads: Vec<String>,
  pub rest: String,
  pub is_done: bool,
}

#[napi]
pub fn frame_sse_chunk(buffer: String, chunk: String) -> SseChunkResult {
  let (payloads, rest, is_done) = sse::frame_chunk(&buffer, &chunk);
  SseChunkResult { payloads, rest, is_done }
}

#[napi]
/// Count tokens using the built-in cl100k-style BPE approximation
/// (punctuation/whitespace pre-tokenization + CJK handling).
pub fn count_tokens(text: String) -> u32 {
  tokenizer::count_tokens(&text) as u32
}

/// Truncate text to at most `max_tokens` tokens without re-tokenizing from
/// scratch repeatedly (binary search over character lengths).
#[napi]
pub fn truncate_to_tokens(text: String, max_tokens: u32) -> String {
  tokenizer::truncate_to_tokens(&text, max_tokens)
}

#[napi(object)]
pub struct CompressResult {
  pub compressed: String,
  pub original_chars: u32,
  pub compressed_chars: u32,
}

/// Apply Deyin wire compression (ANSI strip, timestamp strip, duplicate
/// collapse, error prioritization). Mirrors compressToolOutput rules.
#[napi]
pub fn compress_wire_text(content: String, mode: String) -> CompressResult {
  compress_wire_text_ex(content, mode, Some("tool".to_string()), None)
}

/// Full-fidelity variant with the tool name (noisiness detection) and
/// preserveErrors flag.
#[napi]
pub fn compress_wire_text_ex(
  content: String,
  mode: String,
  tool_name: Option<String>,
  preserve_errors: Option<bool>,
) -> CompressResult {
  let original = content.encode_utf16().count();
  let out = compress::compress_tool_output(
    &content,
    tool_name.as_deref().unwrap_or("tool"),
    compress::Mode::parse(&mode),
    preserve_errors.unwrap_or(false),
  );
  let compressed_chars = out.encode_utf16().count();
  CompressResult {
    compressed: out,
    original_chars: original as u32,
    compressed_chars: compressed_chars as u32,
  }
}

#[napi(object)]
pub struct GrepMatch {
  pub file: String,
  pub line_number: u32,
  pub line_text: String,
}

#[napi(object)]
pub struct GrepResult {
  pub matches: Vec<GrepMatch>,
  pub truncated: bool,
}

/// Parallel regex search over a directory tree with .gitignore-style skips.
#[napi]
pub fn grep(
  root: String,
  pattern: String,
  glob: Option<String>,
  max_results: Option<u32>,
  ignore_case: Option<bool>,
) -> Result<GrepResult> {
  let outcome = grep::search(
    &root,
    &pattern,
    glob.as_deref(),
    max_results.unwrap_or(200) as usize,
    ignore_case.unwrap_or(false),
  )
  .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;
  Ok(GrepResult {
    matches: outcome
      .hits
      .into_iter()
      .map(|h| GrepMatch {
        file: h.file,
        line_number: h.line_number,
        line_text: h.line_text,
      })
      .collect(),
    truncated: outcome.truncated,
  })
}
