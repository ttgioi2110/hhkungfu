const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://hhkungfu.ee";
const PORT = process.env.PORT || 7000;

const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": BASE_URL,
    "X-Requested-With": "XMLHttpRequest"
};

const manifest = {
    id: "org.hhkungfu.donghua",
    version: "1.0.0",
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

// --- CATALOG HANDLER ---
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (type !== "series") return { metas: [] };

    let url = BASE_URL;
    if (extra && extra.search) {
        url = `${BASE_URL}/?s=${encodeURIComponent(extra.search)}`;
    }

    try {
        const { data } = await axios.get(url, { headers, timeout: 8000 });
        const $ = cheerio.load(data);
        const metas = [];

        $(".halim-item, article.item, .list-films .item").each((_, el) => {
            const linkElem = $(el).find("a").first();
            const href = linkElem.attr("href");
            const title = $(el).find(".entry-title, .title, h2, h3").first().text().trim();
            const img = $(el).find("img").first();
            const poster = img.attr("data-src") || img.attr("src");

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

// --- META HANDLER ---
builder.defineMetaHandler(async ({ type, id }) => {
    const slug = id.replace("hhkf_", "");
    const filmUrl = `${BASE_URL}/${slug}/`;

    try {
        const { data } = await axios.get(filmUrl, { headers, timeout: 8000 });
        const $ = cheerio.load(data);

        const title = $(".entry-title, h1.title").first().text().trim() || slug;
        const poster = $(".poster img, .film-poster img").attr("src");
        const description = $(".entry-content p, .film-content").text().trim();

        const videos = [];
        const episodeElements = $("#halim-list-server li a, .list-episodes a");

        if (episodeElements.length > 0) {
            episodeElements.each((i, el) => {
                const epTitle = $(el).text().trim();
                const epHref = $(el).attr("href") || "";
                const episodeNum = i + 1;

                videos.push({
                    id: `hhkf_${slug}_ep_${episodeNum}_${Buffer.from(epHref).toString("base64url")}`,
                    title: epTitle || `Tập ${episodeNum}`,
                    season: 1,
                    episode: episodeNum
                });
            });
        } else {
            // Mặc định 1 tập nếu không phân tập
            videos.push({
                id: `hhkf_${slug}_ep_1_${Buffer.from(filmUrl).toString("base64url")}`,
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

// --- STREAM HANDLER ---
builder.defineStreamHandler(async ({ type, id }) => {
    try {
        const parts = id.split("_");
        const encodedUrl = parts[parts.length - 1];
        const targetUrl = Buffer.from(encodedUrl, "base64url").toString("utf-8");

        const { data } = await axios.get(targetUrl, { headers, timeout: 8000 });
        const $ = cheerio.load(data);

        // Bóc tách nguồn video từ iframe phát lại
        let iframeSrc = $("iframe").attr("src") || $("#player-embed iframe").attr("src");

        if (!iframeSrc) {
            // Trường hợp trang dùng AJAX HalimPlayer
            const episodeId = $(".halim-btn-active").attr("data-post-id");
            const serverId = $(".halim-btn-active").attr("data-server");
            const episodeSlug = $(".halim-btn-active").attr("data-episode");

            if (episodeId) {
                const ajaxRes = await axios.post(
                    `${BASE_URL}/wp-admin/admin-ajax.php`,
                    new URLSearchParams({
                        action: "halim_ajax_player",
                        episode: episodeSlug,
                        postid: episodeId,
                        server: serverId
                    }),
                    { headers }
                );
                if (ajaxRes.data && ajaxRes.data.data) {
                    const embed$ = cheerio.load(ajaxRes.data.data);
                    iframeSrc = embed$("iframe").attr("src");
                }
            }
        }

        if (iframeSrc) {
            if (iframeSrc.startsWith("//")) iframeSrc = "https:" + iframeSrc;

            return {
                streams: [
                    {
                        title: "HHKungFu Web Embed",
                        type: "embed",
                        url: iframeSrc
                    }
                ]
            };
        }

        return { streams: [] };
    } catch (err) {
        console.error("Lỗi Stream:", err.message);
        return { streams: [] };
    }
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Server Addon đang chạy tại cổng: ${PORT}`);