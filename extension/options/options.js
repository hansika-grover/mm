'use strict';
const DEFAULTS = { hubUrl: 'http://127.0.0.1:5051/api/ingest', sourceLabel: '', autoSend: true, autoRun: true, autoRunEveryMin: 10, deepScan: true };
const $ = (s) => document.querySelector(s);

async function load() {
  const c = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  $('#hubUrl').value = c.hubUrl;
  $('#sourceLabel').value = c.sourceLabel;
  $('#autoSend').checked = !!c.autoSend;
  $('#autoRun').checked = !!c.autoRun;
  $('#deepScan').checked = !!c.deepScan;
  $('#autoRunEveryMin').value = c.autoRunEveryMin;
}

$('#save').addEventListener('click', async () => {
  let hubUrl = $('#hubUrl').value.trim() || DEFAULTS.hubUrl;
  if (hubUrl && !/^https?:\/\//i.test(hubUrl)) hubUrl = 'https://' + hubUrl.replace(/^\/+/, '');
  const cfg = {
    hubUrl,
    sourceLabel: $('#sourceLabel').value.trim(),
    autoSend: $('#autoSend').checked,
    autoRun: $('#autoRun').checked,
    deepScan: $('#deepScan').checked,
    autoRunEveryMin: Math.max(1, Number($('#autoRunEveryMin').value) || 10),
  };
  await chrome.storage.local.set(cfg);
  $('#saved').textContent = 'Saved ✓';
  setTimeout(() => ($('#saved').textContent = ''), 1500);
});

load();
