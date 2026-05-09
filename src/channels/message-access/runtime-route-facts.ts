import type { RedactedIngressMatch, RouteGateFacts, RouteSenderPolicy } from "./types.js";

type RouteFactDefaults = {
  id: string;
  kind?: RouteGateFacts["kind"];
  precedence?: number;
  senderPolicy?: RouteSenderPolicy;
  senderAllowFrom?: Array<string | number>;
  senderAllowFromSource?: RouteGateFacts["senderAllowFromSource"];
  match?: RedactedIngressMatch;
};

function routeFact(params: RouteFactDefaults & Pick<RouteGateFacts, "gate" | "effect">) {
  return {
    id: params.id,
    kind: params.kind ?? "route",
    gate: params.gate,
    effect: params.effect,
    precedence: params.precedence ?? 0,
    senderPolicy: params.senderPolicy ?? "inherit",
    senderAllowFrom: params.senderAllowFrom,
    senderAllowFromSource: params.senderAllowFromSource,
    match: params.match,
  } satisfies RouteGateFacts;
}

export function routeDisabledFact(params: RouteFactDefaults): RouteGateFacts {
  return routeFact({ ...params, gate: "disabled", effect: "block-dispatch" });
}

export function routeAllowlistFact(
  params: RouteFactDefaults & { matched: boolean },
): RouteGateFacts {
  return routeFact({
    ...params,
    gate: params.matched ? "matched" : "not-matched",
    effect: params.matched ? "allow" : "block-dispatch",
  });
}

export function nestedRouteAllowlistFact(
  params: RouteFactDefaults & { matched: boolean },
): RouteGateFacts {
  return routeAllowlistFact({ ...params, kind: "nestedAllowlist" });
}

export function routeSenderAllowlistFact(params: RouteFactDefaults): RouteGateFacts {
  return routeFact({
    ...params,
    kind: params.kind ?? "routeSender",
    gate: "matched",
    effect: "allow",
  });
}

export function routeDenyWhenSenderEmptyFact(params: RouteFactDefaults): RouteGateFacts {
  return routeFact({
    ...params,
    gate: "matched",
    effect: "allow",
    senderPolicy: "deny-when-empty",
  });
}
