/* 本地存储：参数版本管理 + 报价快照留痕（localStorage，数据不出本机） */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) { module.exports = factory(); }
  else { root.Store = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VER_KEY = 'pt_param_versions_v1';
  const SNAP_KEY = 'pt_snapshots_v1';
  const MAX_SNAP = 50;

  const mem = {}; // file:// 或隐私模式下 localStorage 不可用时的内存回退
  function ls() {
    try { const t = '__pt_test__'; localStorage.setItem(t, '1'); localStorage.removeItem(t); return localStorage; }
    catch (e) { return null; }
  }
  function read(key, dflt) {
    const s = ls();
    if (!s) return mem[key] || dflt;
    try { const v = s.getItem(key); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; }
  }
  function write(key, val) {
    const s = ls();
    if (!s) { mem[key] = val; return true; }
    try { s.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; }
  }

  function now() {
    const d = new Date();
    const p = n => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function newId(prefix) {
    const d = new Date();
    const p = n => (n < 10 ? '0' : '') + n;
    return prefix + '-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  /* ---- 参数版本 ---- */
  function listVersions(builtin) {
    const user = read(VER_KEY, []);
    return [builtin].concat(user);
  }
  function saveVersion(params, versionName, note) {
    const list = read(VER_KEY, []);
    const copy = JSON.parse(JSON.stringify(params));
    copy.meta.versionId = newId('usr');
    copy.meta.versionName = versionName || copy.meta.versionName || '未命名版本';
    copy.meta.createdAt = now();
    if (note) copy.meta.note = note;
    list.push(copy);
    write(VER_KEY, list);
    return copy;
  }
  function deleteVersion(versionId) {
    write(VER_KEY, read(VER_KEY, []).filter(v => v.meta.versionId !== versionId));
  }

  /* ---- 报价快照 ---- */
  function listSnapshots() { return read(SNAP_KEY, []); }
  function saveSnapshot(snap) {
    const list = read(SNAP_KEY, []);
    snap.snapshotId = newId('snap');
    snap.savedAt = now();
    list.unshift(snap);
    if (list.length > MAX_SNAP) list.length = MAX_SNAP;
    write(SNAP_KEY, list);
    return snap;
  }
  function deleteSnapshot(snapshotId) {
    write(SNAP_KEY, read(SNAP_KEY, []).filter(s => s.snapshotId !== snapshotId));
  }

  return { listVersions, saveVersion, deleteVersion, listSnapshots, saveSnapshot, deleteSnapshot, now };
});
