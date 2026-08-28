import { getCurrentLocale } from '../../../../../scripts/i18n.js';
import { getExtensionAssetPath } from '../index.js';

const AVAILABLE_LOCALES = [
    { code: 'auto', name: 'Auto (SillyTavern)' },
    { code: 'en', name: 'English' },
    { code: 'vi-vn', name: 'Tiếng Việt' },
    { code: 'fr-fr', name: 'Français' },
];
let translations = null;
let currentLocale = 'en';
let localeOverride = 'auto';

const normalizeLocale = value => String(value || 'en').toLowerCase().replace('_', '-');
function variantsFor(locale) {
    const normalized = normalizeLocale(locale);
    const base = normalized.split('-')[0];
    return [...new Set([normalized, base, `${base}-${base}`])];
}

async function fetchLocale(locale) {
    currentLocale = normalizeLocale(locale);
    if (currentLocale.startsWith('en')) {
        translations = null;
        return null;
    }
    for (const variant of variantsFor(currentLocale)) {
        try {
            const response = await fetch(getExtensionAssetPath(`locales/${variant}.json`));
            if (response.ok) {
                translations = await response.json();
                return translations;
            }
        } catch {}
    }
    translations = null;
    return null;
}

function applyTranslatedNode(element) {
    const key = element.getAttribute('data-i18n');
    if (!key) return;
    if (!element.dataset.rmrEnglish) element.dataset.rmrEnglish = element.textContent;
    const text = translations?.[key] || element.dataset.rmrEnglish;
    if (element.children.length) {
        for (const node of element.childNodes) if (node.nodeType === 3 && node.textContent.trim()) { node.textContent = text; return; }
    }
    element.textContent = text;
}

export function getAvailableLocales() { return AVAILABLE_LOCALES.map(item => ({ ...item })); }
export function getLocaleOverride() { return localeOverride; }
export function getLocale() { return currentLocale; }
export function getText(key, fallback) { return translations?.[key] || fallback; }
export const getTutorialText = getText;
export function hasTranslations() { return translations !== null; }

export async function setExtensionLocale(override = 'auto') {
    localeOverride = AVAILABLE_LOCALES.some(item => item.code === override) ? override : 'auto';
    const locale = localeOverride === 'auto' ? (getCurrentLocale() || 'en') : localeOverride;
    await fetchLocale(locale);
    return currentLocale;
}

export async function loadTutorialTranslations() {
    if (!currentLocale) await setExtensionLocale(localeOverride);
    return translations;
}

export async function loadUITranslations(override = 'auto') {
    return setExtensionLocale(override);
}

export function applyExtensionLocale(container) {
    const element = container instanceof jQuery ? container[0] : container;
    if (!element) return;
    if (element.matches?.('[data-i18n]')) applyTranslatedNode(element);
    element.querySelectorAll('[data-i18n]').forEach(applyTranslatedNode);
}
