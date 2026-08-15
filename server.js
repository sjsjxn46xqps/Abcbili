const express = require('express');
const crypto = require('crypto');
const { Readable } = require('stream');
const path = require('path');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

function rand(len) { return Math.floor(Math.random() * Math.pow(36, len)).toString(36).padStart(len, '0'); }
function genBuvid() { return `${rand(8)}${rand(4)}-${rand(4)}-${rand(4)}-${rand(4)}-${rand(12)}infoc`; }

let baseCookies = null;
async function ensureBaseCookies() {
  if (baseCookies) return baseCookies;
  const list = [`buvid3=${genBuvid()}`, `buvid4=${genBuvid()}`, `b_nut=${Math.floor(Date.now() / 1000)}`, `b_lsid=${rand(16)}`];
  try {
    const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'User-Agent': UA, 'Referer': REFERER }
    });
    const j = await res.json();
    if (j && j.data && j.data.b_3) {
      list[0] = `buvid3=${j.data.b_3}`;
      if (j.data.b_4) list[1] = `buvid4=${j.data.b_4}`;
    }
  } catch (e) {}
  baseCookies = list;
  return list;
}

async function biliFetch(url, userCookie = '') {
  const base = await ensureBaseCookies();
  const cookie = base.join('; ') + (userCookie ? '; ' + userCookie : '');
  return fetch(url, { headers: { 'User-Agent': UA, 'Referer': REFERER, 'Cookie': cookie } });
}

// 视频信息
app.get('/api/info', async (req, res) => {
  const bvid = req.query.bvid || '';
  try {
    const r = await biliFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
    res.json(await r.json());
  } catch (e) { res.status(502).json({ code: -1, message: '请求失败: ' + e.message }); }
});

// 播放地址
app.get('/api/playurl', async (req, res) => {
  const { bvid, cid } = req.query;
  const qn = parseInt(req.query.qn) || 80;
  const cookie = req.query.cookie || '';
  try {
    let r = await biliFetch(
      `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=${qn}&fnval=1&fnver=0&fourk=1&platform=html5&high_quality=1`,
      cookie
    );
    let j = await r.json();
    if (j.code === 0 && j.data && (!j.data.durl || !j.data.durl.length)) {
      // 无 mp4 时再尝试 DASH
      const r2 = await biliFetch(
        `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=${qn}&fnval=16&fnver=0&fourk=1&platform=html5`,
        cookie
      );
      const j2 = await r2.json();
      if (j2.code === 0) j.data.dash = j2.data.dash;
    }
    res.json(j);
  } catch (e) { res.status(502).json({ code: -1, message: '请求失败: ' + e.message }); }
});

// 弹幕(XML)
app.get('/api/dm', async (req, res) => {
  const oid = req.query.oid || '';
  try {
    const r = await biliFetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${oid}`);
    const text = await r.text();
    res.type('xml').send(text);
  } catch (e) { res.status(502).send(''); }
});

// 搜索(带 wbi 签名)
const MIXIN_KEY_ENC_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
function getMixinKey(orig) { let s = ''; for (const i of MIXIN_KEY_ENC_TAB) s += orig[i]; return s.slice(0, 32); }

let wbiCache = null;
async function getWbiKeys() {
  if (wbiCache && Date.now() - wbiCache.t < 86400000) return wbiCache;
  const r = await biliFetch('https://api.bilibili.com/x/web-interface/nav');
  const j = await r.json();
  const img = j.data && j.data.wbi_img && j.data.wbi_img.img_url;
  const sub = j.data && j.data.wbi_img && j.data.wbi_img.sub_url;
  if (!img || !sub) throw new Error('获取wbi密钥失败');
  const imgKey = img.split('/').pop().split('.')[0];
  const subKey = sub.split('/').pop().split('.')[0];
  wbiCache = { imgKey, subKey, t: Date.now() };
  return wbiCache;
}
function signParams(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey + subKey);
  params.wts = Math.round(Date.now() / 1000);
  const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
  params.w_rid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return params;
}
app.get('/api/search', async (req, res) => {
  const keyword = req.query.keyword || '';
  try {
    const { imgKey, subKey } = await getWbiKeys();
    const params = signParams({ search_type: 'video', keyword, page: 1 }, imgKey, subKey);
    const qs = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const r = await biliFetch(`https://api.bilibili.com/x/web-interface/wbi/search/type?${qs}`);
    res.json(await r.json());
  } catch (e) { res.status(502).json({ code: -1, message: '搜索失败: ' + e.message }); }
});

// 短链接解析
app.get('/api/resolve', async (req, res) => {
  const url = req.query.url || '';
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': UA } });
    res.json({ url: r.headers.get('location') || url });
  } catch (e) { res.json({ url }); }
});

// 视频流代理(解决 Referer 防盗链 + CORS + 支持拖动 Range)
app.get('/api/stream', async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).send('bad url');
  try {
    const h = { 'User-Agent': UA, 'Referer': REFERER };
    if (req.headers.range) h['Range'] = req.headers.range;
    const upstream = await fetch(url, { headers: h, redirect: 'follow' });
    res.status(upstream.status);
    ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges'].forEach(k => {
      const v = upstream.headers.get(k);
      if (v) res.setHeader(k, v);
    });
    const body = Readable.fromWeb(upstream.body);
    body.on('error', () => res.end());
    res.on('close', () => body.destroy());
    body.pipe(res);
  } catch (e) { res.status(502).send('stream error'); }
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`B站播放器已启动: http://localhost:${PORT}`));
