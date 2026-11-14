import i18n from '../translations';

export function formatNumber(value: number, digits = 1) {
  return new Intl.NumberFormat(i18n.language === 'ar' ? 'ar' : 'en', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}
export function formatMoney(value: number) {
  return `${formatNumber(value)}\u00a0${i18n.language === 'ar' ? 'م' : 'M'}`;
}
