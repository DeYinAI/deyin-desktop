//! High-resolution process watchdog and inactivity monitor.
//! Tracks execution heartbeats and flags process stalls or timeouts.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub struct WatchdogEntry {
  pub id: String,
  pub pid: u32,
  pub timeout_ms: u64,
  pub stall_threshold_ms: u64,
  pub started_at_ms: u64,
  pub last_activity_ms: u64,
  pub heartbeat_count: u64,
}

pub enum WatchdogStatus {
  Running { elapsed_ms: u64, inactive_ms: u64 },
  Stalled { elapsed_ms: u64, inactive_ms: u64 },
  TimedOut { elapsed_ms: u64 },
  NotFound,
}

static WATCHDOGS: OnceLock<Mutex<HashMap<String, WatchdogEntry>>> = OnceLock::new();

fn get_watchdogs() -> &'static Mutex<HashMap<String, WatchdogEntry>> {
  WATCHDOGS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn register(
  id: String,
  pid: u32,
  timeout_ms: u64,
  stall_threshold_ms: u64,
  now_ms: u64,
) {
  let mut map = get_watchdogs().lock().unwrap();
  map.insert(
    id.clone(),
    WatchdogEntry {
      id,
      pid,
      timeout_ms,
      stall_threshold_ms,
      started_at_ms: now_ms,
      last_activity_ms: now_ms,
      heartbeat_count: 0,
    },
  );
}

pub fn record_heartbeat(id: &str, now_ms: u64) -> bool {
  let mut map = get_watchdogs().lock().unwrap();
  if let Some(entry) = map.get_mut(id) {
    entry.last_activity_ms = now_ms;
    entry.heartbeat_count += 1;
    true
  } else {
    false
  }
}

pub fn inspect(id: &str, now_ms: u64) -> WatchdogStatus {
  let map = get_watchdogs().lock().unwrap();
  if let Some(entry) = map.get(id) {
    let elapsed = now_ms.saturating_sub(entry.started_at_ms);
    let inactive = now_ms.saturating_sub(entry.last_activity_ms);

    if entry.timeout_ms > 0 && elapsed >= entry.timeout_ms {
      WatchdogStatus::TimedOut { elapsed_ms: elapsed }
    } else if entry.stall_threshold_ms > 0 && inactive >= entry.stall_threshold_ms {
      WatchdogStatus::Stalled {
        elapsed_ms: elapsed,
        inactive_ms: inactive,
      }
    } else {
      WatchdogStatus::Running {
        elapsed_ms: elapsed,
        inactive_ms: inactive,
      }
    }
  } else {
    WatchdogStatus::NotFound
  }
}

pub fn unregister(id: &str) -> bool {
  let mut map = get_watchdogs().lock().unwrap();
  map.remove(id).is_some()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_watchdog_lifecycle() {
    let id = "test-watchdog-1".to_string();
    register(id.clone(), 1234, 10_000, 2_000, 1000);

    // Initial check at 1500 (500ms after start)
    match inspect(&id, 1500) {
      WatchdogStatus::Running { elapsed_ms, inactive_ms } => {
        assert_eq!(elapsed_ms, 500);
        assert_eq!(inactive_ms, 500);
      }
      _ => panic!("Expected Running status"),
    }

    // Stalled check at 3500 (2500ms without heartbeat)
    match inspect(&id, 3500) {
      WatchdogStatus::Stalled { elapsed_ms, inactive_ms } => {
        assert_eq!(elapsed_ms, 2500);
        assert_eq!(inactive_ms, 2500);
      }
      _ => panic!("Expected Stalled status"),
    }

    // Record heartbeat
    assert!(record_heartbeat(&id, 3500));

    // After heartbeat, at 3600 it should be running again
    match inspect(&id, 3600) {
      WatchdogStatus::Running { inactive_ms, .. } => {
        assert_eq!(inactive_ms, 100);
      }
      _ => panic!("Expected Running status after heartbeat"),
    }

    // Timeout check at 12000
    match inspect(&id, 12000) {
      WatchdogStatus::TimedOut { elapsed_ms } => {
        assert_eq!(elapsed_ms, 11000);
      }
      _ => panic!("Expected TimedOut status"),
    }

    assert!(unregister(&id));
  }
}
