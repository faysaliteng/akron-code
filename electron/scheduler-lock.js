'use strict';

const fs = require('fs');
const path = require('path');

const LEASE_FILENAME = 'scheduler.lock.json';
const DEFAULT_STALE_MS = 25_000;

function leasePathFor(dataDir) {
  return path.join(String(dataDir || '.'), LEASE_FILENAME);
}

function isPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function readSchedulerLease(dataDir) {
  const lp = leasePathFor(dataDir);
  try {
    if (!fs.existsSync(lp)) return null;
    const raw = fs.readFileSync(lp, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function writeLeaseAtomic(lp, lease) {
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  const tmp = `${lp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lease, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, lp);
}

function isLeaseActiveForOther(lease, { owner, pid, staleMs = DEFAULT_STALE_MS, now = Date.now() }) {
  if (!lease) return false;
  if (lease.owner === owner && Number(lease.pid) === Number(pid)) return false;
  if (!isPidAlive(lease.pid)) return false;
  const hb = Number(lease.heartbeatAt || lease.acquiredAt || 0);
  if (!hb || (now - hb) > staleMs) return false;
  return true;
}

function acquireSchedulerLease({ dataDir, owner = 'desktop', pid = process.pid, staleMs = DEFAULT_STALE_MS } = {}) {
  const lp = leasePathFor(dataDir);
  const now = Date.now();
  const current = readSchedulerLease(dataDir);
  if (isLeaseActiveForOther(current, { owner, pid, staleMs, now })) {
    return {
      acquired: false,
      holder: current,
      leasePath: lp,
    };
  }
  const lease = {
    owner: String(owner || 'desktop'),
    pid: Number(pid),
    acquiredAt: current && current.owner === owner && Number(current.pid) === Number(pid)
      ? current.acquiredAt
      : now,
    heartbeatAt: now,
  };
  writeLeaseAtomic(lp, lease);
  return {
    acquired: true,
    lease,
    leasePath: lp,
  };
}

function refreshSchedulerLease({ dataDir, owner = 'desktop', pid = process.pid } = {}) {
  const lp = leasePathFor(dataDir);
  const current = readSchedulerLease(dataDir);
  if (!current || (current.owner === owner && Number(current.pid) === Number(pid)) || !isPidAlive(current.pid)) {
    const lease = {
      owner: String(owner || 'desktop'),
      pid: Number(pid),
      acquiredAt: current?.acquiredAt || Date.now(),
      heartbeatAt: Date.now(),
    };
    writeLeaseAtomic(lp, lease);
    return { ok: true, lease };
  }
  return { ok: false, holder: current };
}

function releaseSchedulerLease({ dataDir, owner = 'desktop', pid = process.pid } = {}) {
  const lp = leasePathFor(dataDir);
  const current = readSchedulerLease(dataDir);
  if (!current) return { ok: true, released: false };
  if ((current.owner === owner && Number(current.pid) === Number(pid)) || !isPidAlive(current.pid)) {
    try { fs.unlinkSync(lp); } catch (_) {}
    return { ok: true, released: true };
  }
  return { ok: false, released: false, holder: current };
}

function canOwnerRunScheduler({ dataDir, owner = 'desktop', pid = process.pid, staleMs = DEFAULT_STALE_MS } = {}) {
  const current = readSchedulerLease(dataDir);
  if (!current) return true;
  if (isLeaseActiveForOther(current, { owner, pid, staleMs })) {
    return false;
  }
  return true;
}

module.exports = {
  LEASE_FILENAME,
  DEFAULT_STALE_MS,
  leasePathFor,
  isPidAlive,
  readSchedulerLease,
  acquireSchedulerLease,
  refreshSchedulerLease,
  releaseSchedulerLease,
  canOwnerRunScheduler,
};
