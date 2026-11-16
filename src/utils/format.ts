import i18n from '../translations';

/**
 * Locale-aware number formatting, e.g. for counts and ratings.
 *
 * Not used for money: see formatMoney (demo, already in millions) and
 * formatCompactMoney (live, raw units) below.
 */
export function formatNumber(value: number, digits = 1) {
  return new Intl.NumberFormat(i18n.language === 'ar' ? 'ar' : 'en', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

/**
 * Format an amount that is already expressed in MILLIONS - the demo model
 * (budget 100, price 5.5).
 *
 * Trailing ".0" is dropped so a whole-million value reads "5M" / "100M" instead of
 * "5.0M" / "100.0M". The suffix is separated by a real space rather than a
 * non-breaking one so the text can never be forced onto one unbreakable line - on a
 * 360px phone the summary cells had no legal break point, which is one of the
 * reasons the strip overflowed.
 */
export function formatMoney(value: number) {
  const rounded = Math.round(value * 10) / 10;
  const text = new Intl.NumberFormat(i18n.language === 'ar' ? 'ar' : 'en', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(rounded);
  return `${text} ${i18n.language === 'ar' ? 'م' : 'M'}`;
}

/**
 * Format a raw currency amount (as stored in the live database) as millions.
 *
 * The live schema stores league budgets and player prices in whole currency units
 * - numeric(12,2) with a 100000000 default budget - while the demo model stores
 * millions (5.5, 100). Passing a raw amount to formatMoney() therefore printed
 * "5,000,000.0 M" for a 5M player, because formatMoney() labels but does not scale.
 *
 * Kept as a separate export so the two scales can never be confused again: demo
 * numbers go through formatMoney, live numbers go through formatCompactMoney.
 */
export function formatCompactMoney(value: number) {
  return formatMoney(value / 1_000_000);
}
