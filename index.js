const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://hhkungfu.ee";
const PORT = process.env.PORT || 7000;

const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": BASE_URL,
    "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7"
};

const manifest = {
    id: "org.hhkungfu.donghua",
    version: "1.0.1",
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
        const { data } = await axios.get(url, { headers, timeout: 10000 });
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

// 2. META HANDLER
builder.defineMetaHandler(async ({ id }) => {
    const slug = id.replace("hhkf_", "");
    const filmUrl = `${BASE_URL}/${slug}/`;

    try {
        const { data } = await axios.get(filmUrl, { headers, timeout: 10000 });
        const $ = cheerio.load(data);

        const title = $(".entry-title, h1.title").first().text().trim() || slug;
        const poster = $(".poster img, .film-poster img").attr("src");
        const description = $(".entry-content p, .film-content").text().trim();

        const videos = [];
        const episodeElements = $("#halim-list-server li a, .list-episodes a, .halim-episode a");

        if (episodeElements.length > 0) {
            episodeElements.each((i, el) => {
                const epTitle = $(el).text().trim();
                const epHref = $(el).attr("href") || "";
                const episodeNum = i + 1;

                if (epHref) {
                    videos.push({
                        id: `hhkf_${slug}_ep_${episodeNum}_${Buffer.from(epHref).toString("base64url")}`,
                        title: epTitle || `Tập ${episodeNum}`,
                        season: 1,
                        episode: episodeNum
                    });
                }
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
    try {
        const parts = id.split("_");
        const encodedUrl = parts[parts.length - 1];
        let targetUrl = Buffer.from(encodedUrl, "base64url").toString("utf-8");

        if (!targetUrl.startsWith("http")) {
            targetUrl = `${BASE_URL}${targetUrl.startsWith('/') ? '' : '/'}${targetUrl}`;
        }

        const { data } = await axios.get(targetUrl, { headers, timeout: 10000 });
        const $ = cheerio.load(data);

        let streamUrl = "";

        // Kiểm tra player nhúng iframe
        let iframeSrc = $("#player-embed iframe, .player-embed iframe, iframe").first().attr("src");

        if (!iframeSrc) {
            // Gửi request AJAX lấy link player nếu dùng HalimPlayer
            const episodeId = $(".halim-btn-active").attr("data-post-id") || $("#player-embed").attr("data-post-id");
            const serverId = $(".halim-btn-active").attr("data-server") || "1";
            const episodeSlug = $(".halim-btn-active").attr("data-episode");

            if (episodeId) {
                const params = new URLSearchParams();
                params.append("action", "halim_ajax_player");
                params.append("episode", episodeSlug || "");
                params.append("postid", episodeId);
                params.append("server", serverId);

                const ajaxRes = await axios.post(`${BASE_URL}/wp-admin/admin-ajax.php`, params, {
                    headers: {
                        ...headers,
                        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                        "X-Requested-With": "XMLHttpRequest"
                    }
                });

                if (ajaxRes.data && ajaxRes.data.data) {
                    const embed$ = cheerio.load(ajaxRes.data.data);
                    iframeSrc = embed$("iframe").attr("src");
                }
            }
        }

        if (iframeSrc) {
            if (iframeSrc.startsWith("//")) iframeSrc = "https:" + iframeSrc;
            streamUrl = iframeSrc;
        }

        if (streamUrl) {
            return {
                streams: [
                    {
                        name: "HHKungFu",
                        title: "Server VIP - Web Player",
                        url: streamUrl,
                        behaviorHints: {
                            notSupportedInBrowser: false,
                            proxyHeaders: {
                                request: {
                                    "User-Agent": headers["User-Agent"],
                                    "Referer": BASE_URL
                                }
                            }
                        }
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
