/** Minor units → "-25.50". The formatted string is what assistants show; the integer is for arithmetic. */
export function formatAmount(minor: number): string {
  return `${minor < 0 ? '-' : ''}${(Math.abs(minor) / 100).toFixed(2)}`;
}

export const money = (minor: number) => ({ amount: minor, formatted: formatAmount(minor) });
