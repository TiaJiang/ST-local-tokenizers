import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_KEY = 'localTokenizers';

const DEFAULTS = {
    enabled: true,
    safetyMultiplier: 1.10,
    cjkCharsPerToken: 1.6,
    asciiCharsPerToken: 3.2,
    otherCharsPerToken: 2.7,
    punctuationPenalty: 0.25,
    newlinePenalty: 0.45,
    urlPenalty: 3.5,
    codeFencePenalty: 2.0,
};

let patched = false;

function getSettings() {
    if (!extension_settings[MODULE_KEY] || typeof extension_settings[MODULE_KEY] !== 'object') {
        extension_settings[MODULE_KEY] = { ...DEFAULTS };
    }

    extension_settings[MODULE_KEY] = {
        ...DEFAULTS,
        ...extension_settings[MODULE_KEY],
    };

    return extension_settings[MODULE_KEY];
}

function clamp(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function guesstimateText(str) {
    if (typeof str !== 'string' || str.length === 0) {
        return 0;
    }

    const s = getSettings();

    const cjkCount = (str.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
    const asciiWordCount = (str.match(/[A-Za-z0-9]/g) || []).length;
    const newlineCount = (str.match(/\n/g) || []).length;
    const punctuationCount = (str.match(/[^\w\s]|_/g) || []).length;
    const urlCount = (str.match(/https?:\/\/\S+|www\.\S+/gi) || []).length;
    const codeFenceCount = (str.match(/```/g) || []).length;
    const remainingCount = Math.max(str.length - cjkCount - asciiWordCount, 0);

    const base =
        cjkCount / s.cjkCharsPerToken +
        asciiWordCount / s.asciiCharsPerToken +
        remainingCount / s.otherCharsPerToken +
        punctuationCount * s.punctuationPenalty +
        newlineCount * s.newlinePenalty +
        urlCount * s.urlPenalty +
        codeFenceCount * s.codeFencePenalty;

    return Math.max(1, Math.ceil(base * s.safetyMultiplier));
}

function stringifyMessage(message) {
    if (!message || typeof message !== 'object') {
        return '';
    }

    const chunks = [];

    if (typeof message.role === 'string') chunks.push(message.role);
    if (typeof message.name === 'string') chunks.push(message.name);

    if (Array.isArray(message.content)) {
        for (const item of message.content) {
            if (!item || typeof item !== 'object') continue;

            if (typeof item.text === 'string') chunks.push(item.text);
            if (typeof item.input_text === 'string') chunks.push(item.input_text);
            if (typeof item.url === 'string') chunks.push(item.url);

            if (typeof item.image_url === 'string') {
                chunks.push(item.image_url);
            } else if (item.image_url && typeof item.image_url.url === 'string') {
                chunks.push(item.image_url.url);
            }
        }
    } else if (typeof message.content === 'string') {
        chunks.push(message.content);
    }

    if (message.tool_calls !== undefined) {
        chunks.push(typeof message.tool_calls === 'string' ? message.tool_calls : JSON.stringify(message.tool_calls));
    }

    if (message.tool_call_id !== undefined) {
        chunks.push(String(message.tool_call_id));
    }

    if (message.function_call !== undefined) {
        chunks.push(typeof message.function_call === 'string' ? message.function_call : JSON.stringify(message.function_call));
    }

    return chunks.filter(Boolean).join('\n');
}

function estimateTokenCountFromRequestBody(data) {
    let messages = [];
    try {
        messages = typeof data === 'string' ? JSON.parse(data) : data;
    } catch {
        messages = [];
    }

    if (!Array.isArray(messages)) {
        messages = [messages];
    }

    // 与 ST 现有逻辑保持一致
    let tokenCount = -1;
    for (const message of messages) {
        tokenCount += guesstimateText(stringifyMessage(message));
    }
    return tokenCount;
}

function extractAjaxOptions(args) {
    // 兼容 $.ajax(options) 和 $.ajax(url, options)
    if (args.length > 0 && typeof args[0] === 'string') {
        return { ...(args[1] || {}), url: args[0] };
    }
    if (args.length > 0 && typeof args[0] === 'object') {
        return args[0] || {};
    }
    return {};
}

function isOpenAiCountRequest(url) {
    const u = String(url || '');
    return u.includes('/api/tokenizers/openai/count');
}

function patchJQueryAjax() {
    if (patched || !window.jQuery || !window.jQuery.ajax) return false;

    const originalAjax = window.jQuery.ajax.bind(window.jQuery);
    patched = true;

    window.jQuery.ajax = function patchedAjax(...args) {
        const options = extractAjaxOptions(args);
        const s = getSettings();

        if (!s.enabled || !isOpenAiCountRequest(options.url)) {
            return originalAjax(...args);
        }

        const token_count = estimateTokenCountFromRequestBody(options.data);
        const payload = { token_count };

        if (typeof options.success === 'function') {
            try {
                options.success(payload);
            } catch (err) {
                console.warn('[Local Tokenizers] success callback failed', err);
            }
        }

        const dfd = window.jQuery.Deferred();
        dfd.resolve(payload);

        console.debug('[Local Tokenizers] intercepted:', options.url, '=>', token_count);
        return dfd.promise();
    };

    console.info('[Local Tokenizers] ajax hook installed');
    return true;
}

function injectSettingsUi() {
    if (document.getElementById('local_tokenizers_settings_block')) return;

    const html = `
<div id="local_tokenizers_settings_block" class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
        <b>Local Tokenizers</b>
    </div>
    <div class="inline-drawer-content">
        <label class="checkbox_label">
            <input id="local_tokenizers_enabled" type="checkbox" />
            启用本地 token 估算拦截
        </label>

        <div style="margin-top: 8px;">
            <label for="local_tokenizers_safety_multiplier">Safety Multiplier</label>
            <div style="display: flex; gap: 8px; align-items: center;">
                <input id="local_tokenizers_safety_multiplier" type="range" min="1.00" max="1.30" step="0.01" style="flex: 1;" />
                <input id="local_tokenizers_safety_multiplier_num" type="number" min="1.00" max="1.30" step="0.01" style="width: 84px;" />
            </div>
            <small>越大越保守（高估越多）。建议 1.06 ~ 1.12。</small>
        </div>
    </div>
</div>`;

    const host =
        document.querySelector('#extensions_settings2') ||
        document.querySelector('#extensions_settings') ||
        document.querySelector('#extensionsMenu') ||
        document.body;

    host.insertAdjacentHTML('beforeend', html);

    const s = getSettings();

    const enabled = document.getElementById('local_tokenizers_enabled');
    const slider = document.getElementById('local_tokenizers_safety_multiplier');
    const number = document.getElementById('local_tokenizers_safety_multiplier_num');

    if (!(enabled instanceof HTMLInputElement) || !(slider instanceof HTMLInputElement) || !(number instanceof HTMLInputElement)) {
        console.warn('[Local Tokenizers] settings UI bind failed');
        return;
    }

    enabled.checked = !!s.enabled;
    slider.value = String(s.safetyMultiplier);
    number.value = String(s.safetyMultiplier);

    enabled.addEventListener('input', () => {
        s.enabled = !!enabled.checked;
        saveSettingsDebounced();
    });

    const syncMultiplier = (value) => {
        s.safetyMultiplier = Number(clamp(value, 1.00, 1.30, DEFAULTS.safetyMultiplier).toFixed(2));
        slider.value = String(s.safetyMultiplier);
        number.value = String(s.safetyMultiplier);
        saveSettingsDebounced();
    };

    slider.addEventListener('input', () => syncMultiplier(slider.value));
    number.addEventListener('input', () => syncMultiplier(number.value));
}

function boot() {
    getSettings();
    injectSettingsUi();
}

// 先尽早安装 ajax hook，避免错过早期请求
(function installHookEarly(retry = 0) {
    if (patchJQueryAjax()) return;
    if (retry < 120) {
        setTimeout(() => installHookEarly(retry + 1), 50);
    } else {
        console.warn('[Local Tokenizers] failed to install ajax hook in time');
    }
})();

// DOM 就绪后再挂设置 UI
jQuery(() => {
    boot();
});