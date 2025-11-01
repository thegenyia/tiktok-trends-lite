import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as cheerio from 'cheerio';

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

/**
 * Gera um User-Agent realista para reduzir 403.
 */
function randomUA() {
  const uas = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0'
  ];
  return uas[Math.floor(Math.random() * uas.length)];
}

/**
 * Monta URL pública do TikTok para busca.
 * Ex.: https://www.tiktok.com/search?q=dentista&lang=pt-BR
 */
function buildSearchUrl(q, country) {
  // country influencia idioma; não é filtro rígido (sem login).
  const lang = country && country.toUpperCase() === 'BR' ? 'pt-BR' : 'en';
  const encoded = encodeURIComponent(q);
  return `https://www.tiktok.com/search?q=${encoded}&lang=${lang}`;
}

/**
 * Extrai o JSON do <script id="SIGI_STATE"> e retorna objeto.
 */
function extractSigiState(html) {
  const $ = cheerio.load(html);
  const node = $('#SIGI_STATE');
  if (!node.length) return null;
  const raw = node.text();
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * Converte SIGI_STATE.ItemModule em array de vídeos com campos normalizados.
 */
function normalizeFromItemModule(sigi, maxItems = 50) {
  if (!sigi || !sigi.ItemModule) return [];
  const items = Object.values(sigi.ItemModule);

  const list = items.slice(0, maxItems).map((it) => {
    const id = it.id || it.aweme_id || '';
    const author = it.author || (it.authorInfo && it.authorInfo.uniqueId) || '';
    const title = it.desc || it.title || '';
    const stats = it.stats || {};
    const music = it.music || {};
    const video = it.video || {};

    // Alguns campos aparecem com nomes alternativos
    const playCount = stats.playCount ?? stats.playCount ?? null;
    const diggCount = stats.diggCount ?? stats.likeCount ?? null;
    const commentCount = stats.commentCount ?? null;
    const shareCount = stats.shareCount ?? null;
    const collectCount = stats.collectCount ?? null;

    // Monta URL canônica
    const url = it.shareUrl || it.videoUrl || (author && id ? `https://www.tiktok.com/@${author}/video/${id}` : '');

    return {
      id,
      title,
      author,
      url,
      cover: video.cover || video.dynamicCover || video.originCover || null,
      duration: video.duration || null,
      music: {
        title: music.title || null,
        author: music.authorName || null
      },
      stats: {
        views: playCount,
        likes: diggCount,
        comments: commentCount,
        shares: shareCount,
        bookmarks: collectCount
      },
      publishedAt: it.createTime ? new Date(Number(it.createTime) * 1000).toISOString() : null,
      hashtags: Array.isArray(it.textExtra)
        ? it.textExtra.filter(h => h.hashtagName).map(h => h.hashtagName)
        : []
    };
  });

  // Remove os que não têm URL (ruído)
  return list.filter(v => v.url);
}

/**
 * Tenta URL alternativa de hashtag (quando o termo for bem "parecido" com hashtag).
 * Ex.: https://www.tiktok.com/tag/dentista?lang=pt-BR
 */
function buildHashtagUrl(q, country) {
  const clean = q.replace(/^#/, '').trim();
  const lang = country && country.toUpperCase() === 'BR' ? 'pt-BR' : 'en';
  return `https://www.tiktok.com/tag/${encodeURIComponent(clean)}?lang=${lang}`;
}

async function fetchHtml(url) {
  const headers = {
    'User-Agent': randomUA(),
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://www.tiktok.com/',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Cache-Control': 'no-cache',
    // Pequeno cookie para se parecer com sessão webid (ajuda a reduzir alguns 403)
    'Cookie': `tt_webid_v2=${Math.floor(Math.random() * 10**16)};`
  };

  const res = await axios.get(url, {
    headers,
    // Evita gzip/brotli no Railway para simplificar parsing
    decompress: true,
    timeout: 15000,
    // Algumas vezes seguir redirecionamentos ajuda ao resolver consent screens
    maxRedirects: 3,
    validateStatus: s => s >= 200 && s < 400
  });

  return res.data;
}

/**
 * Health check
 */
app.get('/', (req, res) => {
  res.type('text').send('Use ?q=palavra para buscar no TikTok (ex: /search?q=dentista)');
});

/**
 * Alias prático /search
 */
app.get('/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const max = Math.min(Number(req.query.max || 50), 100);
  const country = (req.query.country || 'BR').toString();

  if (!q) {
    return res.status(400).json({ error: 'Parâmetro q é obrigatório. Ex.: /search?q=dentista' });
  }

  try {
    // 1) Busca principal
    const url = buildSearchUrl(q, country);
    const html = await fetchHtml(url);
    let sigi = extractSigiState(html);
    let results = normalizeFromItemModule(sigi, max);

    // 2) Fallback por hashtag se o primeiro veio vazio
    if (!results.length) {
      const hUrl = buildHashtagUrl(q, country);
      const hHtml = await fetchHtml(hUrl);
      sigi = extractSigiState(hHtml);
      results = normalizeFromItemModule(sigi, max);
    }

    return res.json({
      query: q,
      country,
      total: results.length,
      results
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Falha ao buscar vídeos',
      details: err?.message || String(err)
    });
  }
});

app.listen(PORT, () => {
  console.log(`tiktok-trends-lite rodando na porta ${PORT}`);
});
