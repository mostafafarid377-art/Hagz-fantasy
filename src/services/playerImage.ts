/** A stable, non-URL reference to an object in the private player-images bucket. */
export const STORAGE_IMAGE_PREFIX = 'storage-image:';
export function playerImage(player: { image_path?: string | null; image_url?: string | null }): string | undefined {
  return player.image_path ? `${STORAGE_IMAGE_PREFIX}${player.image_path}` : player.image_url ?? undefined;
}
