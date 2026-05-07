/**
 * Fixed session for REST headers and checkpoint keys (aligned with `StarDeliveryWebDefaults` in the .NET web host).
 * The HTTP server always uses these values; clients cannot override them.
 */
export const ENFORCED_PLAYER_GUID = "bdcd133d-74a8-4b15-a13b-b545501a40de";
export const ENFORCED_PLAYER_EMAIL = "nelson.pinto@version1.com";

export function getEnforcedPlayer(): { playerGuid: string; playerEmail: string } {
  return {
    playerGuid: ENFORCED_PLAYER_GUID,
    playerEmail: ENFORCED_PLAYER_EMAIL,
  };
}
