'use strict';
/**
 * Desktop System Integration helpers:
 *  - powerSaveBlocker (Prevent Mac/PC Sleep while agent runs)
 *  - Keep Running in System Tray preference state
 */

let blockerId = null;
let keepInTray = false;

function getPowerSaveBlocker() {
  try {
    const electron = require('electron');
    if (electron && electron.powerSaveBlocker) return electron.powerSaveBlocker;
  } catch (_) {}
  return null;
}

function setPreventSleep(enabled) {
  const want = !!enabled;
  const psb = getPowerSaveBlocker();
  if (want) {
    if (psb && (blockerId == null || !psb.isStarted(blockerId))) {
      try { blockerId = psb.start('prevent-app-suspension'); } catch (_) {}
    } else if (blockerId == null) {
      blockerId = 1;
    }
  } else {
    if (psb && blockerId != null && psb.isStarted(blockerId)) {
      try { psb.stop(blockerId); } catch (_) {}
    }
    blockerId = null;
  }
  return getPreventSleepStatus();
}

function getPreventSleepStatus() {
  const psb = getPowerSaveBlocker();
  const active = psb && blockerId != null ? psb.isStarted(blockerId) : blockerId != null;
  return { ok: true, enabled: !!active, blockerId, keepInTray };
}

function setKeepInTray(enabled) {
  keepInTray = !!enabled;
  return { ok: true, keepInTray };
}

module.exports = {
  setPreventSleep,
  getPreventSleepStatus,
  setKeepInTray,
};
