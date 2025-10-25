let gettextFn = text => text;
let ngettextFn = (singular, plural, count) => (count === 1 ? singular : plural);

export const _ = gettextFn;
export const ngettext = ngettextFn;
