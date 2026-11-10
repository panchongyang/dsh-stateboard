/** Fixture: typed pure logic used by the .tsx bundle probe. */
export function formatCount(count: number): string {
  return count === 1 ? '1 item' : count + ' items';
}
