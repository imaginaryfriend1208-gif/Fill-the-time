import { getCurrentLocale, addLocaleData, applyLocale } from '../../../../../scripts/i18n.js';
let translations=null,currentLocale=null,uiLoaded=false;
async function fetchLocale(){const locale=getCurrentLocale()||'en';if(translations&&currentLocale===locale)return translations;currentLocale=locale;for(const variant of [locale,locale.split('-')[0],`${locale.split('-')[0]}-${locale.split('-')[0]}`]){try{const response=await fetch(`/scripts/extensions/third-party/fill-the-time/locales/${variant}.json`);if(response.ok){translations=await response.json();return translations;}}catch{}}translations=null;return null;}
export async function loadTutorialTranslations(){return fetchLocale();}
export async function loadUITranslations(){if(uiLoaded)return;const locale=getCurrentLocale()||'en';if(!locale.startsWith('en')){const data=await fetchLocale();if(data)addLocaleData(locale,data);}uiLoaded=true;}
export function applyExtensionLocale(container){const element=container instanceof jQuery?container[0]:container;if(element)applyLocale(element);}
export function getTutorialText(key,fallback){return translations?.[key]||fallback;}
export function hasTranslations(){return translations!==null;}
export function getLocale(){return currentLocale||getCurrentLocale()||'en';}
