/** Fee-juice amounts for operator output. 1 FJ = 1e18 wei. */
const FJ = 10n ** 18n;

export function formatFeeJuiceWei(wei: bigint): string {
  if (wei < 0n) return `-${formatFeeJuiceWei(-wei)}`;
  const whole = wei / FJ;
  const frac = wei % FJ;
  if (frac === 0n) return `${whole} FJ`;
  const fracStr = frac.toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return `${whole}.${fracStr || '0'} FJ (${wei} wei)`;
}
