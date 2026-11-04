//#region Constants
const PLATFORM = "PlayVids";
const BASE_URL = "https://www.playvids.com";
const VIDEOS_URL = BASE_URL + "/videos";
const SUGGEST_URL = BASE_URL + "/s/suggests-all";
const COMMENTS_URL = BASE_URL + "/v/comments-more";

const IS_DESKTOP = bridge.buildPlatform === "desktop";
const IS_ANDROID = bridge.buildPlatform === "android";

const USER_AGENT_FALLBACK = IS_DESKTOP
    ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.200 Safari/537.36"
    : "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.200 Mobile Safari/537.36";

/**
 * Returns the best available user agent string.
 * Prefers the user agent from the auth or captcha webview if available,
 * falling back to a hardcoded browser string.
 * @returns {string} User agent string
 */
const getUserAgent = () => bridge.authUserAgent ?? bridge.captchaUserAgent ?? USER_AGENT_FALLBACK;

const REQUEST_HEADERS = {
    "User-Agent": getUserAgent(),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": BASE_URL + "/"
};

const XHR_HEADERS = { "X-Requested-With": "XMLHttpRequest" };

const DEFAULT_RETRIES = 2;
const RATE_LIMIT_WAIT_MS = 3000;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;
const SECONDS_PER_WEEK = 604800;
const MILLISECONDS_PER_SECOND = 1000;
const FIRST_PAGE = 1;

// Pagination strategies for the video pager, selected per feed type.
const PAGINATION_AUTO = "auto";     // pages that expose a .pagination element
const PAGINATION_COUNT = "count";   // "/feed" fragments that end on an empty page
//#endregion

//#region Regex
// Video URL: https://www.playvids.com/{id} or /{id}/{slug} or /embed/{id}
const REGEX_PLAYVIDS_HOST = /^https?:\/\/(?:www\.)?playvids\.com\//i;
// Captures the video id anywhere in a URL or relative href; the id is a base62
// token of at least 9 characters (reserved words like "categories" are excluded
// by REGEX_ID_GUARD below because they contain no digit or uppercase letter).
const REGEX_VIDEO_ID = /\/(?:embed\/)?([0-9A-Za-z]{9,})(?:[/?#]|$)/;
const REGEX_ID_GUARD = /[0-9A-Z]/;
// Channel URL: /u/{name}, /channel/{name}, /pornstar/{name}
const REGEX_CHANNEL_URL = /^https?:\/\/(?:www\.)?playvids\.com\/(u|channel|pornstar)\/([^/?#]+)/i;
const REGEX_CHANNEL_PATH = /\/(u|channel|pornstar)\/([^/?#]+)/i;
// Studio/network channel page, e.g. /RealityKings/free — a channel listing, not a video.
const REGEX_STUDIO_URL = /^https?:\/\/(?:www\.)?playvids\.com\/[A-Za-z0-9_-]+\/free\/?(?:[?#].*)?$/i;
// HLS master playlist fallback when it cannot be read from the <source> element.
const REGEX_HLS_IN_BODY = /https?:\/\/[^"'\s]+master\.m3u8[^"'\s]*/i;
// ISO-8601-style duration used in the page JSON-LD (e.g. "PT1H2M3S" or "T5M0S").
const REGEX_ISO_HOURS = /(\d+)H/;
const REGEX_ISO_MINUTES = /(\d+)M/;
const REGEX_ISO_SECONDS = /(\d+)S/;
// Best-effort follower/subscriber count on channel and pornstar pages.
const REGEX_SUBSCRIBERS = /([\d.,]+)\s*([KM])?\s*(?:Subscribers|Followers)/i;
// Relative time label on feed cards, e.g. "19m ago", "2d ago", "6d ago".
const REGEX_RELATIVE_TIME = /(\d+)\s*(s|m|h|d|w)\s*ago/i;
// A "just posted" label with no numeric offset.
const REGEX_JUST_NOW = /^(?:just now|now|moments? ago)$/i;
// Absolute date label starting with a month abbreviation, e.g. "Jun 24" or "Dec 16, 2022".
const REGEX_MONTH_DATE = /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i;
//#endregion

//#region State
let config = {};
let _settings = {};
//#endregion

//#region Source lifecycle
/**
 * Initializes the plugin with its configuration and settings.
 * @param {Object} conf - Plugin configuration object.
 * @param {Object} settings - User-configured plugin settings.
 * @param {string} savedState - Serialized state from a previous session (unused).
 */
source.enable = function (conf, settings, savedState) {
    config = conf ?? {};
    _settings = settings ?? {};
};

/**
 * Serializes plugin state for persistence. PlayVids requires no persistent state.
 * @returns {string} Empty string.
 */
source.saveState = () => "";
//#endregion

//#region Home
/**
 * Returns the platform home feed (most recently added videos).
 * @returns {VideoPager} Pager over the home feed.
 */
source.getHome = function () {
    return new PlayVidsVideoPager(BASE_URL + "/", FIRST_PAGE, PAGINATION_AUTO);
};
//#endregion

//#region Search
/**
 * Returns search suggestions for the given query.
 * @param {string} query - Partial search query.
 * @returns {string[]} List of suggested search terms.
 */
source.searchSuggestions = function (query) {
    try {
        const json = httpGET({
            url: SUGGEST_URL + "?q=" + encodeURIComponent(query ?? ""),
            parseResponse: true,
            headers: XHR_HEADERS
        });
        const searches = json?.suggest?.searches;
        if (searches && typeof searches === "object" && !Array.isArray(searches)) {
            return Object.keys(searches);
        }
        return [];
    } catch (error) {
        log("searchSuggestions failed: " + error);
        return [];
    }
};

/**
 * Declares the search capabilities. PlayVids search supports neither sort nor
 * filter parameters, so only the content type is advertised.
 * @returns {ResultCapabilities} Supported search types, sorts, and filters.
 */
source.getSearchCapabilities = () => ({
    types: [Type.Feed.Mixed],
    sorts: [],
    filters: []
});

/**
 * Searches for videos matching the query. A video URL query returns that video.
 * @param {string} query - Search query or a video URL.
 * @param {string} type - Requested content type (unused; only videos are returned).
 * @param {string} order - Requested sort order (unsupported by the platform).
 * @param {Object} filters - Selected filters (unsupported by the platform).
 * @returns {ContentPager|VideoPager} Pager over the search results.
 */
source.search = function (query, type, order, filters) {
    if (query && source.isContentDetailsUrl(query)) {
        return new ContentPager([source.getContentDetails(query)], false);
    }
    return new PlayVidsVideoPager(VIDEOS_URL + "?qry=" + encodeURIComponent(query ?? ""), FIRST_PAGE, PAGINATION_AUTO);
};

/**
 * Searches for channels and pornstars matching the query using the suggest API.
 * @param {string} query - Partial channel or pornstar name.
 * @returns {ChannelPager} Pager over the matching channels.
 */
source.searchChannels = function (query) {
    const results = [];
    try {
        const json = httpGET({
            url: SUGGEST_URL + "?q=" + encodeURIComponent(query ?? ""),
            parseResponse: true,
            headers: XHR_HEADERS
        });
        for (const group of [json?.suggest?.stars, json?.suggest?.channels]) {
            if (group && typeof group === "object" && !Array.isArray(group)) {
                for (const name of Object.keys(group)) {
                    const channelUrl = group[name];
                    if (!channelUrl) {
                        continue;
                    }
                    results.push(new PlatformChannel({
                        id: new PlatformID(PLATFORM, channelIdFromHref(channelUrl), config.id),
                        name,
                        banner: "",
                        subscribers: 0,
                        description: "",
                        url: channelUrl,
                        links: {}
                    }));
                }
            }
        }
    } catch (error) {
        log("searchChannels failed: " + error);
    }
    return new ChannelPager(results, false);
};
//#endregion

//#region Channel
/**
 * Determines whether a URL points to a PlayVids channel, user, or pornstar page.
 * @param {string} url - URL to test.
 * @returns {boolean} True if the URL is a channel URL.
 */
source.isChannelUrl = (url) => REGEX_CHANNEL_URL.test(url);

/**
 * Fetches metadata for a channel, user, or pornstar page.
 * @param {string} url - Channel URL.
 * @returns {PlatformChannel} The resolved channel.
 */
source.getChannel = function (url) {
    const parts = channelTypeAndName(url);
    const canonicalUrl = BASE_URL + "/" + parts.type + "/" + parts.name;

    let name = channelDisplayName(parts.type, parts.name);
    let thumbnail = "";
    let banner = "";
    let description = "";
    let subscribers = 0;

    try {
        const body = httpGET({ url: canonicalUrl });
        const doc = domParser.parseFromString(body, "text/html");
        try {
            thumbnail = attr(doc.querySelector('meta[property="og:image"]'), "content");
            description = attr(doc.querySelector('meta[name="description"]'), "content");
            subscribers = parseSubscribers(body);
        } finally {
            disposeDoc(doc);
        }
    } catch (error) {
        log("getChannel failed: " + error);
    }

    return new PlatformChannel({
        id: new PlatformID(PLATFORM, parts.type + "/" + parts.name, config.id),
        name,
        ...(thumbnail ? { thumbnail } : {}),
        banner,
        subscribers,
        description,
        url: canonicalUrl,
        links: {}
    });
};

/**
 * Declares the channel content capabilities. PlayVids channel pages support
 * neither sort nor filter parameters.
 * @returns {ResultCapabilities} Supported channel content types, sorts, and filters.
 */
source.getChannelCapabilities = () => ({
    types: [Type.Feed.Mixed],
    sorts: [],
    filters: []
});

/**
 * Returns the videos published on a channel, user, or pornstar page.
 * User and pornstar pages load additional videos over a "/feed" endpoint;
 * channel pages paginate via ?page=N. Results are sorted newest-first.
 * @param {string} url - Channel URL.
 * @returns {VideoPager} Pager over the channel's videos.
 */
source.getChannelContents = function (url) {
    const parts = channelTypeAndName(url);
    const sortByDate = true;
    if (parts.type === "channel") {
        // Channel pages paginate via ?page=N with a .pagination element.
        return new PlayVidsVideoPager(BASE_URL + "/channel/" + parts.name, FIRST_PAGE, PAGINATION_AUTO, sortByDate);
    }
    return new PlayVidsVideoPager(BASE_URL + "/" + parts.type + "/" + parts.name + "/feed", FIRST_PAGE, PAGINATION_COUNT, sortByDate);
};
//#endregion

//#region Content details
/**
 * Determines whether a URL points to a PlayVids video.
 * @param {string} url - URL to test.
 * @returns {boolean} True if the URL is a video details URL.
 */
source.isContentDetailsUrl = (url) =>
    REGEX_PLAYVIDS_HOST.test(url) && extractVideoId(url) !== null
    && !source.isChannelUrl(url) && !REGEX_STUDIO_URL.test(url);

/**
 * Fetches full details for a video, including its HLS stream and recommendations.
 * Embed URLs (/embed/{id}) serve the stream but no metadata, so they are resolved
 * to their canonical watch page before parsing.
 * @param {string} url - Video URL.
 * @returns {PlatformVideoDetails} The resolved video details.
 * @throws {ScriptException} If the page cannot be fetched.
 */
source.getContentDetails = function (url) {
    const id = extractVideoId(url);
    let body = httpGET({ url });
    let doc = domParser.parseFromString(body, "text/html");

    // The embed page carries the <source> but no title/JSON-LD/author; follow its
    // canonical link to the full watch page so metadata is populated.
    if (!doc.querySelector("h1")) {
        const canonical = attr(doc.querySelector('link[rel="canonical"]'), "href");
        if (canonical && canonical !== url && source.isContentDetailsUrl(canonical)) {
            disposeDoc(doc);
            url = canonical;
            body = httpGET({ url });
            doc = domParser.parseFromString(body, "text/html");
        }
    }

    try {
        const jsonLd = getVideoJsonLd(doc);

        let name = text(doc.querySelector("h1"));
        if (!name && jsonLd?.name) {
            name = jsonLd.name;
        }

        let thumbnail = "";
        if (jsonLd?.thumbnailUrl) {
            thumbnail = Array.isArray(jsonLd.thumbnailUrl) ? jsonLd.thumbnailUrl[0] : jsonLd.thumbnailUrl;
        }
        if (!thumbnail) {
            thumbnail = attr(doc.querySelector('meta[property="og:image"]'), "content");
        }

        const duration = jsonLd?.duration ? parseIsoDuration(jsonLd.duration) : 0;
        const datetime = jsonLd?.uploadDate ? dateToUnixSeconds(jsonLd.uploadDate) : 0;
        const viewCount = jsonLd?.interactionCount ? parseCount(String(jsonLd.interactionCount)) : 0;
        const description = jsonLd?.description ?? "";

        const sources = [];
        let hlsUrl = attr(doc.querySelector("video source"), "src");
        if (!hlsUrl) {
            const match = body.match(REGEX_HLS_IN_BODY);
            if (match) {
                hlsUrl = match[0].replace(/&amp;/g, "&");
            }
        }
        if (hlsUrl) {
            sources.push(new HLSSource({ name: "HLS", url: hlsUrl, duration, priority: true }));
        }

        const details = new PlatformVideoDetails({
            id: new PlatformID(PLATFORM, id, config.id),
            name,
            thumbnails: buildThumbnails(thumbnail),
            author: parseDetailAuthor(doc),
            datetime,
            duration,
            viewCount,
            url,
            shareUrl: url,
            isLive: false,
            description,
            video: new VideoSourceDescriptor(sources)
        });

        const recommendations = parseVideoCards(doc, id);
        details.getContentRecommendations = function () {
            return new VideoPager(recommendations, false);
        };
        return details;
    } finally {
        disposeDoc(doc);
    }
};

/**
 * Returns videos related to the given video, parsed from the video page.
 * @param {string} url - Video URL.
 * @returns {VideoPager} Pager over the recommended videos.
 */
source.getContentRecommendations = function (url) {
    try {
        const body = httpGET({ url });
        const doc = domParser.parseFromString(body, "text/html");
        try {
            return new VideoPager(parseVideoCards(doc, extractVideoId(url)), false);
        } finally {
            disposeDoc(doc);
        }
    } catch (error) {
        log("getContentRecommendations failed: " + error);
        return new VideoPager([], false);
    }
};
//#endregion

//#region Comments
/**
 * Fetches the comments for a video. Comments are paginated by the platform.
 * @param {string} url - Video URL.
 * @returns {CommentPager} Pager over the video's comments.
 */
source.getComments = function (url) {
    const id = extractVideoId(url);
    if (!id) {
        return new CommentPager([], false);
    }
    return new PlayVidsCommentPager(url, id, FIRST_PAGE);
};
//#endregion

//#region Helpers
/**
 * Centralized HTTP GET wrapper with retry, error handling, and optional JSON parsing.
 * @param {Object} options
 * @param {string} options.url - The request URL.
 * @param {boolean} [options.parseResponse=false] - Whether to JSON-parse the response body.
 * @param {number} [options.retries=2] - Number of retry attempts on transient failures.
 * @param {Object} [options.headers={}] - Per-request header overrides merged with default headers.
 * @param {boolean} [options.useAuthenticated=false] - Whether to use the authenticated HTTP client.
 * @returns {Object|string} Parsed JSON object or raw response body string.
 * @throws {ScriptException} On unrecoverable HTTP errors.
 */
function httpGET({ url, parseResponse = false, retries = DEFAULT_RETRIES, headers = {}, useAuthenticated = false }) {
    const mergedHeaders = { ...REQUEST_HEADERS, ...headers };
    let attempts = retries + 1;
    let lastError;

    while (attempts > 0) {
        try {
            const resp = http.GET(url, mergedHeaders, useAuthenticated);

            if (resp.code === HTTP_TOO_MANY_REQUESTS) {
                log("Rate limited on " + url + " - waiting before retry");
                bridge.sleep(RATE_LIMIT_WAIT_MS);
                attempts--;
                continue;
            }

            if (resp.code >= HTTP_SERVER_ERROR) {
                log("Server error " + resp.code + " on " + url);
                lastError = new ScriptException("Server error " + resp.code);
                attempts--;
                continue;
            }

            if (!resp.isOk) {
                throw new ScriptException("Request failed [" + resp.code + "]: " + url);
            }

            return parseResponse ? JSON.parse(resp.body) : resp.body;
        } catch (error) {
            lastError = error;
            attempts--;
        }
    }

    log("Request failed after " + (retries + 1) + " attempt(s): " + url);
    throw lastError;
}

/**
 * Extracts the video id from a video URL or relative href, or null if none.
 * @param {string} url - URL or relative href.
 * @returns {string|null} The video id, or null if the URL is not a video.
 */
function extractVideoId(url) {
    if (!url) {
        return null;
    }
    const match = url.match(REGEX_VIDEO_ID);
    if (!match || !REGEX_ID_GUARD.test(match[1])) {
        return null;
    }
    return match[1];
}

/**
 * Extracts the channel type and slug from a channel URL.
 * @param {string} url - Channel URL.
 * @returns {{type: string, name: string}} The channel type ("u"/"channel"/"pornstar") and slug.
 */
function channelTypeAndName(url) {
    const match = url.match(REGEX_CHANNEL_URL);
    return { type: match[1].toLowerCase(), name: match[2] };
}

/**
 * Builds a stable channel id ("type/slug") from a channel URL or relative href.
 * @param {string} href - Channel URL or relative href.
 * @returns {string} The channel id.
 */
function channelIdFromHref(href) {
    const match = href.match(REGEX_CHANNEL_PATH);
    return match ? match[1].toLowerCase() + "/" + match[2] : href.replace(/^\//, "").replace(/[/?#].*$/, "");
}

/**
 * Builds a human-readable display name for a channel from its type and slug.
 * @param {string} type - Channel type ("u"/"channel"/"pornstar").
 * @param {string} slug - URL slug.
 * @returns {string} Display name.
 */
function channelDisplayName(type, slug) {
    let decoded;
    try {
        decoded = decodeURIComponent(slug);
    } catch (error) {
        decoded = slug;
    }
    return type === "u" ? decoded : decoded.replace(/[-_]+/g, " ").trim();
}

/**
 * Converts a possibly-relative href into an absolute PlayVids URL.
 * @param {string} href - URL or relative href.
 * @returns {string} Absolute URL, or empty string if href is falsy.
 */
function absoluteUrl(href) {
    if (!href) {
        return "";
    }
    if (/^https?:\/\//i.test(href)) {
        return href;
    }
    return BASE_URL + (href.startsWith("/") ? href : "/" + href);
}

/**
 * Returns a Thumbnails object for a single thumbnail URL, or an empty one.
 * @param {string} url - Thumbnail URL.
 * @returns {Thumbnails} The Thumbnails object.
 */
function buildThumbnails(url) {
    return url ? new Thumbnails([new Thumbnail(url, 0)]) : new Thumbnails([]);
}

/**
 * Returns a fallback author link used when a video has no associated uploader.
 * @returns {PlatformAuthorLink} A placeholder author link.
 */
function unknownAuthor() {
    return new PlatformAuthorLink(new PlatformID(PLATFORM, "unknown", config.id), "", "", null);
}

/**
 * Returns the trimmed text content of a DOM element, or empty string.
 * @param {Object} element - DOM element or null.
 * @returns {string} Trimmed text content.
 */
function text(element) {
    return element ? (element.textContent ?? "").trim() : "";
}

/**
 * Returns a trimmed attribute value of a DOM element, or empty string.
 * @param {Object} element - DOM element or null.
 * @param {string} attribute - Attribute name.
 * @returns {string} Trimmed attribute value.
 */
function attr(element, attribute) {
    return element ? (element.getAttribute(attribute) ?? "").trim() : "";
}

/**
 * Parses the VideoObject JSON-LD block from a video page.
 * @param {Object} doc - Parsed HTML document.
 * @returns {Object|null} The parsed JSON-LD object, or null if none is present.
 */
function getVideoJsonLd(doc) {
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (let i = 0; i < scripts.length; i++) {
        try {
            const parsed = JSON.parse(scripts[i].textContent);
            if (parsed && (parsed["@type"] === "VideoObject" || parsed.uploadDate || parsed.duration)) {
                return parsed;
            }
        } catch (error) {
            log("Failed to parse JSON-LD: " + error);
        }
    }
    return null;
}

/**
 * Parses all video cards in a document into PlatformVideo objects.
 * @param {Object} doc - Parsed HTML document.
 * @param {string} [excludeId] - Video id to exclude (e.g. the current video).
 * @param {boolean} [sortByDateDesc=false] - Sort results newest-first by upload date.
 * @returns {PlatformVideo[]} The parsed videos.
 */
function parseVideoCards(doc, excludeId, sortByDateDesc = false) {
    const cards = doc.querySelectorAll(".itemVideo");
    const entries = [];
    for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const href = findVideoHref(card);
        if (!href) {
            continue;
        }
        const id = extractVideoId(href);
        if (!id || (excludeId && id === excludeId)) {
            continue;
        }
        // Parse the date once so it can drive both the object and the sort;
        // PlatformVideo.dateTime is a native binding and not readable back in-script.
        const datetime = parseDateLabel(text(card.querySelector(".time-addition")));
        entries.push({ video: buildVideoFromCard(card, href, id, datetime), datetime });
    }
    if (sortByDateDesc) {
        entries.sort((a, b) => b.datetime - a.datetime);
    }
    return entries.map((entry) => entry.video);
}

/**
 * Finds the first anchor in a card whose href points to a video.
 * @param {Object} card - DOM element for a video card.
 * @returns {string|null} The video href, or null if none is found.
 */
function findVideoHref(card) {
    const anchors = card.getElementsByTagName("a");
    for (let i = 0; i < anchors.length; i++) {
        const href = anchors[i].getAttribute("href");
        if (href && extractVideoId(href)) {
            return href;
        }
    }
    return null;
}

/**
 * Builds a PlatformVideo from a parsed video card element.
 * @param {Object} card - DOM element for a video card.
 * @param {string} href - Video href extracted from the card.
 * @param {string} id - Video id extracted from the href.
 * @param {number} datetime - Upload timestamp in seconds parsed from the card.
 * @returns {PlatformVideo} The parsed video.
 */
function buildVideoFromCard(card, href, id, datetime) {
    const url = absoluteUrl(href);
    const image = card.querySelector("img");

    let name = text(card.querySelector(".card-title"));
    if (!name && image) {
        name = attr(image, "alt");
    }

    let thumbnail = "";
    if (image) {
        thumbnail = attr(image, "src") || attr(image, "data-src");
    }

    return new PlatformVideo({
        id: new PlatformID(PLATFORM, id, config.id),
        name,
        thumbnails: buildThumbnails(thumbnail),
        duration: parseDurationText(text(card.querySelector(".duration"))),
        viewCount: 0,
        url,
        shareUrl: url,
        isLive: false,
        datetime,
        author: parseCardAuthor(card)
    });
}

/**
 * Parses the uploader link from a video card.
 * @param {Object} card - DOM element for a video card.
 * @returns {PlatformAuthorLink} The card's author, or a fallback author.
 */
function parseCardAuthor(card) {
    const anchor = card.querySelector(".autor a") ?? card.querySelector('a[href^="/u/"]');
    const href = attr(anchor, "href");
    if (!href) {
        return unknownAuthor();
    }
    return new PlatformAuthorLink(
        new PlatformID(PLATFORM, channelIdFromHref(href), config.id),
        text(anchor),
        absoluteUrl(href),
        null
    );
}

/**
 * Parses the uploader link from a video details page (the first user/channel link).
 * @param {Object} doc - Parsed HTML document.
 * @returns {PlatformAuthorLink} The uploader, or a fallback author.
 */
function parseDetailAuthor(doc) {
    const anchor = doc.querySelector('a[href^="/u/"]')
        ?? doc.querySelector('a[href^="/channel/"]')
        ?? doc.querySelector('a[href^="/pornstar/"]');
    const href = attr(anchor, "href");
    const name = text(anchor);
    if (!href || !name) {
        return unknownAuthor();
    }
    return new PlatformAuthorLink(
        new PlatformID(PLATFORM, channelIdFromHref(href), config.id),
        name,
        absoluteUrl(href),
        null
    );
}

/**
 * Determines whether a paginated feed has a page beyond the current one.
 * @param {Object} doc - Parsed HTML document.
 * @param {number} currentPage - The page number that was just fetched.
 * @returns {boolean} True if a higher page number is linked in the pagination.
 */
function hasNextPage(doc, currentPage) {
    const pagination = doc.querySelector(".pagination");
    if (!pagination) {
        return false;
    }
    const anchors = pagination.getElementsByTagName("a");
    for (let i = 0; i < anchors.length; i++) {
        const href = anchors[i].getAttribute("href");
        const match = href ? href.match(/[?&]page=(\d+)/) : null;
        if (match && parseInt(match[1], 10) > currentPage) {
            return true;
        }
    }
    return false;
}

/**
 * Parses a "MM:SS" or "HH:MM:SS" duration string into seconds.
 * @param {string} value - Duration string.
 * @returns {number} Duration in seconds.
 */
function parseDurationText(value) {
    if (!value) {
        return 0;
    }
    const parts = value.split(":").map((part) => parseInt(part, 10));
    if (parts.some((part) => Number.isNaN(part))) {
        return 0;
    }
    return parts.reduce((total, part) => total * SECONDS_PER_MINUTE + part, 0);
}

/**
 * Parses an ISO-8601-style duration ("PT1H2M3S" / "T5M0S") into seconds.
 * @param {string} value - ISO duration string.
 * @returns {number} Duration in seconds.
 */
function parseIsoDuration(value) {
    if (!value) {
        return 0;
    }
    const hours = value.match(REGEX_ISO_HOURS);
    const minutes = value.match(REGEX_ISO_MINUTES);
    const seconds = value.match(REGEX_ISO_SECONDS);
    return (hours ? parseInt(hours[1], 10) * SECONDS_PER_MINUTE * SECONDS_PER_MINUTE : 0)
        + (minutes ? parseInt(minutes[1], 10) * SECONDS_PER_MINUTE : 0)
        + (seconds ? parseInt(seconds[1], 10) : 0);
}

/**
 * Converts an ISO date string to a Unix timestamp in seconds.
 * @param {string} isoString - ISO date string.
 * @returns {number} Unix timestamp in seconds, or 0 if unparseable.
 */
function dateToUnixSeconds(isoString) {
    const milliseconds = Date.parse(isoString);
    return Number.isNaN(milliseconds) ? 0 : Math.floor(milliseconds / MILLISECONDS_PER_SECOND);
}

/**
 * Parses a date label into a Unix timestamp. Handles both relative labels
 * ("19m ago", "2d ago") and absolute dates ("Jun 24", "Dec 16, 2022").
 * @param {string} value - Date label.
 * @returns {number} Unix timestamp in seconds, or 0 if unparseable.
 */
function parseDateLabel(value) {
    if (!value) {
        return 0;
    }
    const trimmed = value.trim();
    const nowSeconds = Math.floor(Date.now() / MILLISECONDS_PER_SECOND);

    if (REGEX_JUST_NOW.test(trimmed)) {
        return nowSeconds;
    }

    const relative = trimmed.match(REGEX_RELATIVE_TIME);
    if (relative) {
        const amount = parseInt(relative[1], 10);
        const unitSeconds = {
            s: 1,
            m: SECONDS_PER_MINUTE,
            h: SECONDS_PER_HOUR,
            d: SECONDS_PER_DAY,
            w: SECONDS_PER_WEEK
        }[relative[2].toLowerCase()];
        return nowSeconds - amount * unitSeconds;
    }

    // Only attempt Date.parse on genuine month-name dates; the runtime parses
    // arbitrary strings leniently (e.g. "just now 2026" -> Jan 1), so guard strictly.
    if (REGEX_MONTH_DATE.test(trimmed)) {
        const normalized = /\d{4}/.test(trimmed) ? trimmed : trimmed + " " + new Date().getFullYear();
        const milliseconds = Date.parse(normalized);
        if (!Number.isNaN(milliseconds)) {
            return Math.floor(milliseconds / MILLISECONDS_PER_SECOND);
        }
    }
    return 0;
}

/**
 * Parses a count string such as "1,234", "1.2K", or "3M" into an integer.
 * @param {string} value - Count string.
 * @returns {number} The parsed count.
 */
function parseCount(value) {
    if (!value) {
        return 0;
    }
    const match = value.match(/([\d.,]+)\s*([KM])?/i);
    if (!match) {
        return 0;
    }
    let number = parseFloat(match[1].replace(/,/g, ""));
    if (Number.isNaN(number)) {
        return 0;
    }
    const suffix = (match[2] ?? "").toUpperCase();
    if (suffix === "K") {
        number *= 1000;
    } else if (suffix === "M") {
        number *= 1000 * 1000;
    }
    return Math.round(number);
}

/**
 * Extracts a best-effort subscriber/follower count from a channel page body.
 * @param {string} body - Raw HTML body.
 * @returns {number} Subscriber count, or 0 if none is found.
 */
function parseSubscribers(body) {
    const match = body.match(REGEX_SUBSCRIBERS);
    return match ? parseCount(match[1] + (match[2] ?? "")) : 0;
}

/**
 * Fetches and parses a single page of comments for a video.
 * @param {string} contentUrl - The video URL (used as each comment's context).
 * @param {string} id - The video id.
 * @param {number} page - Comment page number.
 * @returns {Comment[]} Parsed comments (empty array on error or past the last page).
 */
function fetchCommentPage(contentUrl, id, page) {
    let body;
    try {
        body = httpGET({ url: COMMENTS_URL + "/" + id + "?page=" + page, headers: XHR_HEADERS });
    } catch (error) {
        log("fetchCommentPage failed: " + error);
        return [];
    }
    const doc = domParser.parseFromString("<ul>" + body + "</ul>", "text/html");
    try {
        const items = doc.querySelectorAll("li[data-comment-id]");
        const results = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const authorEl = item.querySelector(".name-autor a");
            const message = text(item.querySelector(".comment-text p") ?? item.querySelector("p"));
            if (!message) {
                continue;
            }
            const authorHref = attr(authorEl, "href");
            results.push(new Comment({
                contextUrl: contentUrl,
                author: new PlatformAuthorLink(
                    new PlatformID(PLATFORM, authorHref ? channelIdFromHref(authorHref) : "unknown", config.id),
                    text(authorEl),
                    authorHref ? absoluteUrl(authorHref) : "",
                    null
                ),
                message,
                date: parseDateLabel(text(item.querySelector(".time-add"))),
                replyCount: 0,
                context: {}
            }));
        }
        return results;
    } finally {
        disposeDoc(doc);
    }
}

/**
 * Disposes a parsed HTML document on platforms that require explicit cleanup.
 * @param {Object} doc - Parsed HTML document.
 */
function disposeDoc(doc) {
    if (IS_ANDROID) {
        doc?.dispose();
    }
}
//#endregion

//#region Pagers
/**
 * Pager over a paginated PlayVids video feed (home, search, channel, pornstar).
 */
class PlayVidsVideoPager extends VideoPager {
    /**
     * @param {string} baseUrl - Feed URL without the page parameter.
     * @param {number} page - Page number to fetch.
     * @param {string} paginationMode - One of PAGINATION_AUTO or PAGINATION_COUNT.
     * @param {boolean} [sortByDate=false] - Sort each page newest-first by upload date.
     */
    constructor(baseUrl, page, paginationMode, sortByDate = false) {
        const { results, hasMore } = fetchVideoPage(baseUrl, page, paginationMode, sortByDate);
        super(results, hasMore, { baseUrl, page, paginationMode, sortByDate });
    }

    /**
     * Fetches and loads the next page of results.
     * @returns {PlayVidsVideoPager} This pager, updated in place.
     */
    nextPage() {
        this.context.page += 1;
        const { results, hasMore } = fetchVideoPage(this.context.baseUrl, this.context.page, this.context.paginationMode, this.context.sortByDate);
        this.results = results;
        this.hasMore = hasMore;
        return this;
    }
}

/**
 * Pager over a video's paginated comments. The platform ends pagination with an
 * empty page, so hasMore tracks whether the last fetched page yielded comments.
 */
class PlayVidsCommentPager extends CommentPager {
    /**
     * @param {string} contentUrl - The video URL (each comment's context).
     * @param {string} id - The video id.
     * @param {number} page - Comment page number to fetch.
     */
    constructor(contentUrl, id, page) {
        const results = fetchCommentPage(contentUrl, id, page);
        super(results, results.length > 0, { contentUrl, id, page });
    }

    /**
     * Fetches and loads the next page of comments.
     * @returns {PlayVidsCommentPager} This pager, updated in place.
     */
    nextPage() {
        this.context.page += 1;
        this.results = fetchCommentPage(this.context.contentUrl, this.context.id, this.context.page);
        this.hasMore = this.results.length > 0;
        return this;
    }
}

/**
 * Fetches and parses a single page of a video feed.
 * @param {string} baseUrl - Feed URL without the page parameter.
 * @param {number} page - Page number to fetch.
 * @param {string} paginationMode - One of PAGINATION_AUTO or PAGINATION_COUNT.
 * @param {boolean} [sortByDate=false] - Sort the page newest-first by upload date.
 * @returns {{results: PlatformVideo[], hasMore: boolean}} Parsed videos and pagination state.
 */
function fetchVideoPage(baseUrl, page, paginationMode, sortByDate = false) {
    const url = baseUrl + (baseUrl.includes("?") ? "&" : "?") + "page=" + page;
    let body;
    try {
        // "/feed" fragments are loaded by the site over XHR; mirror that header.
        body = httpGET({ url, headers: baseUrl.includes("/feed") ? XHR_HEADERS : {} });
    } catch (error) {
        log("fetchVideoPage failed: " + error);
        return { results: [], hasMore: false };
    }
    const doc = domParser.parseFromString(body, "text/html");
    try {
        const results = parseVideoCards(doc, undefined, sortByDate);
        let hasMore = false;
        if (results.length > 0) {
            if (paginationMode === PAGINATION_COUNT) {
                hasMore = true;
            } else if (paginationMode === PAGINATION_AUTO) {
                hasMore = hasNextPage(doc, page);
            }
        }
        return { results, hasMore };
    } finally {
        disposeDoc(doc);
    }
}
//#endregion

log("loaded");
