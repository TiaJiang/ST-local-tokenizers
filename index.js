let patched = false;

const SETTINGS = {
    // 越大越保守（高估更多）
    safetyMultiplier: 1.10,
    cjkCharsPerToken: 1.6,
    asciiCharsPerToken: 3.2,
    otherCharsPerToken: 2.7,
    punctuationPenalty: 0.25,
    newlinePenalty: 0.45,
    urlPenalty: 3.5,
    codeFencePenalty: 2.0,
};

function guesstimateText(str) {
    if (typeof str !== 'string' || str.length === 0) return 0;

    const cjkCount = (str.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
    const asciiWordCount = (str.match(/[A-Za-z0-9]/g) || []).length;
    const newlineCount = (str.match(/\n/g) || []).length;
    const punctuationCount = (str.match(/[^\w\s]|_/g) || []).length;
    const urlCount = (str.match(/https?:\/\/\S+|www\.\S+/gi) || []).length;
    const codeFenceCount = (str.match(/```/g) || []).length;
    const remainingCount = Math.max(str.length - cjkCount - asciiWordCount, 0);

    const base =
        cjkCount / SETTINGS.cjkCharsPerToken +
        asciiWordCount / SETTINGS.asciiCharsPerToken +
        remainingCount / SETTINGS.otherCharsPerToken +
        punctuationCount * SETTINGS.punctuationPenalty +
        newlineCount * SETTINGS.newlinePenalty +
        urlCount * SETTINGS.urlPenalty +
        codeFenceCount * SETTINGS.codeFencePenalty;

    return Math.max(1, Math.ceil(base * SETTINGS.safetyMultiplier));
}

function stringifyMessage(message) {
    if (!message || typeof message !== 'object') return '';

    const chunks = [];
    if (typeof message.role === 'string') chunks.push(message.role);
    if (typeof message.name === 'string') chunks.push(message.name);

    if (Array.isArray(message.content)) {
        for (const item of message.content) {
            if (!item || typeof item !== 'object') continue;
            if (typeof item.text === 'string') chunks.push(item.text);
            if (typeof item.input_text === 'string') chunks.push(item.input_text);
            if (typeof item.url === 'string') chunks.push(item.url);
            if (typeof item.image_url === 'string') chunks.push(item.image_url);
            else if (item.image_url && typeof item.image_url.url === 'string') chunks.push(item.image_url.url);
        }
    } else if (typeof message.content === 'string') {
        chunks.push(message.content);
    }

    if (message.tool_calls !== undefined) {
        chunks.push(typeof message.tool_calls === 'string' ? message.tool_calls : JSON.stringify(message.tool_calls));
    }
    if (message.tool_call_id !== undefined) chunks.push(String(message.tool_call_id));
    if (message.function_call !== undefined) {
        chunks.push(typeof message.function_call === 'string' ? message.function_call : JSON.stringify(message.function_call));
    }

    return chunks.filter(Boolean).join('\n');
}

function estimateFromBody(data) {
    let messages = [];
    try {
        messages = typeof data === 'string' ? JSON.parse(data) : data;
    } catch {
        messages = [];
    }
    if (!Array.isArray(messages)) messages = [messages];

    let tokenCount = -1; // 与 ST 原逻辑对齐
    for (const message of messages) {
        tokenCount += guesstimateText(stringifyMessage(message));
    }
    return tokenCount;
}

function isOpenAICountRequest(options) {
    const url = String(options?.url || '');
    return url.startsWith('/api/tokenizers/openai/count');
}

function patchAjax() {
    if (patched || !window.jQuery?.ajax) return;
    patched = true;

    const originalAjax = window.jQuery.ajax.bind(window.jQuery);

    window.jQuery.ajax = function patchedAjax(...args) {
        const options = (args.length > 0 && typeof args[0] === 'object') ? args[0] : {};
        if (!isOpenAICountRequest(options)) {
            return originalAjax(...args);
        }

        const token_count = estimateFromBody(options.data);
        const payload = { token_count };

        // 兼容 success 回调
        if (typeof options.success === 'function') {
            try { options.success(payload); } catch {}
        }

        const dfd = window.jQuery.Deferred();
        dfd.resolve(payload);
        return dfd.promise();
    };

    console.log('[Local Token Estimator] ajax hook enabled');
}

jQuery(() => {
    patchAjax();
});