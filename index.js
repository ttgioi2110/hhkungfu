const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://hhkungfu.ee";
const PORT = process.env.PORT || 7000;

const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": BASE_URL,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

const manifest = {
    id: "org.hhkungfu.donghua",
    version: "1.0.4",
    name: "HHKungFu Donghua",
    description: "Xem phim Hoạt Hình Trung Quốc 3D trực tiếp từ HHKungFu",
    resources: ["catalog", "meta", "stream"],
    types: ["series"],
    catalogs: [
        {
            type: "series",
            id: "hhkf_catalog",
            name: "HHKungFu",
            extra: [{ name: "search", isRequired: false }]
        }
    ],
    idPrefixes: ["hhkf_"]
};

const builder = new addonBuilder(manifest);

// 1. CATALOG HANDLER
builder.defineCatalogHandler(async ({ type, extra }) => {
    if (type !== "series") return { metas: [] };

    let url = BASE_URL;
    if (extra && extra.search) {
        url = `${BASE_URL}/?s=${encodeURIComponent(extra.search)}`;
    }

    try {
        const { data } = await axios.get(url, { headers, timeout: 5000 });
        const $ = cheerio.load(data);
        const metas = [];

        $(".halim-item, article.item, .list-films .item, .item").each((_, el) => {
            const linkElem = $(el).find("a").first();
            const href = linkElem.attr("href");
            const title = $(el).find(".entry-title, .title, h2, h3").first().text().trim();
            const img = $(el).find("img").first();
            const poster = img.attr("data-src") || img.attr("src") || img.attr("data-lazy-src");

            if (href && title) {
                const slug = href.replace(BASE_URL, "").replace(/\//g, "");
                metas.push({
                    id: `hhkf_${slug}`,
                    type: "series",
                    name: title,
                    poster: poster ? (poster.startsWith("http") ? poster : `${BASE_URL}${poster}`) : "",
                    description: title
                });
            }
        });

        return { metas };
    } catch (err) {
        console.error("Lỗi Catalog:", err.message);
        return { metas: [] };
    }
});

// 2. META HANDLER
builder.defineMetaHandler(async ({ id }) => {
    const slug = id.replace("hhkf_", "");
    const filmUrl = `${BASE_URL}/${slug}/`;

    try {
        const { data } = await axios.get(filmUrl, { headers, timeout: 5000 });
        const $ = cheerio.load(data);

        const title = $(".entry-title, h1.title, .name").first().text().trim() || slug;
        const poster = $(".poster img, .film-poster img, .entry-thumb img").attr("src");
        const description = $(".entry-content p, .film-content, .description").text().trim();

        const videos = [];
        const episodeElements = $("#halim-list-server li a, .list-episodes a, .halim-episode a, .halim-list-eps a");

        if (episodeElements.length > 0) {
            episodeElements.each((i, el) => {
                const epTitle = $(el).text().trim();
                const epHref = $(el).attr("href") || "";
                const episodeNum = i + 1;

                if (epHref) {
                    const b64Href = Buffer.from(epHref).toString("base64url");
                    videos.push({
                        id: `hhkf_${slug}___ep_${episodeNum}___${b64Href}`,
                        title: epTitle || `Tập ${episodeNum}`,
                        season: 1,
                        episode: episodeNum
                    });
                }
            });
        }

        if (videos.length === 0) {
            const b64Href = Buffer.from(filmUrl).toString("base64url");
            videos.push({
                id: `hhkf_${slug}___ep_1___${b64Href}`,
                title: "Tập 1",
                season: 1,
                episode: 1
            });
        }

        return {
            meta: {
                id,
                type: "series",
                name: title,
                poster: poster ? (poster.startsWith("http") ? poster : `${BASE_URL}${poster}`) : "",
                description,
                videos
            }
        };
    } catch (err) {
        console.error("Lỗi Meta:", err.message);
        return { meta: null };
    }
});

// 3. STREAM HANDLER
builder.defineStreamHandler(async ({ id }) => {
    const streams = [];
    let targetUrl = BASE_URL;

    try {
        const parts = id.split("___");
        if (parts.length >= 3) {
            const b64Href = parts[2];
            targetUrl = Buffer.from(b64Href, "base64url").toString("utf-8");
        }

        if (!targetUrl.startsWith("http")) {
            targetUrl = `${BASE_URL}${targetUrl.startsWith("/") ? "" : "/"}${targetUrl}`;
        }

        // Tải nội dung trang tập phim với giới hạn 3.5 giây
        const { data } = await axios.get(targetUrl, { headers, timeout: 3500 });
        const $ = cheerio.load(data);

        // 1. Tìm trực tiếp file .m3u8 trong HTML/JS
        const m3u8Match = data.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
        if (m3u8Match) {
            streams.push({
                name: "HHKungFu VIP",
                title: "▶️ Server Direct M3U8 (Fast)",
                url: m3u8Match[1]
            });
        }

        // 2. Tìm iframe player
        let iframeSrc = $("#player-embed iframe, .player-embed iframe, iframe").first().attr("src");

        if (!iframeSrc) {
            const episodeId = $(".halim-btn-active").attr("data-post-id") || $("#player-embed").attr("data-post-id");
            const serverId = $(".halim-btn-active").attr("data-server") || "1";
            const episodeSlug = $(".halim-btn-active").attr("data-episode");

            if (episodeId) {
                const params = new URLSearchParams({
                    action: "halim_ajax_player",
                    episode: episodeSlug || "",
                    postid: episodeId,
                    server: serverId
                });

                const ajaxRes = await axios.post(`${BASE_URL}/wp-admin/admin-ajax.php`, params, {
                    headers: {
                        ...headers,
                        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                        "X-Requested-With": "XMLHttpRequest"
                    },
                    timeout: 3000
                });

                let embedHtml = "";
                if (ajaxRes.data && ajaxRes.data.data) {
                    embedHtml = ajaxRes.data.data;
                } else if (typeof ajaxRes.data === "string") {
                    embedHtml = ajaxRes.data;
                }

                if (embedHtml) {
                    const embed$ = cheerio.load(embedHtml);
                    iframeSrc = embed$("iframe").attr("src");
                }
            }
        }

        if (iframeSrc) {
            if (iframeSrc.startsWith("//")) iframeSrc = "https:" + iframeSrc;

            streams.push({
                name: "HHKungFu Player",
                title: "▶️ Player HHKungFu (Direct)",
                url: iframeSrc,
                behaviorHints: {
                    notSupportedInBrowser: false,
                    proxyHeaders: {
                        request: {
                            "User-Agent": headers["User-Agent"],
                            "Referer": BASE_URL
                        }
                    }
                }
            });
        }
    } catch (err) {
        console.error("Lỗi lấy luồng phim:", err.message);
    }

    // Luồng dự phòng tuyệt đối: Luôn xuất hiện để không bao giờ bị lỗi "Không tìm thấy luồng nào"
    streams.push({
        name: "HHKungFu Web",
        title: "🌐 Xem Trên Trình Duyệt Web",
        externalUrl: targetUrl
    });

    return { streams };
});

serveHTTP(builder.getInterface(), { port: PORT });
