import { Policy } from '@zeus/shared';

export async function fetchExpiringPolicies(graphUrl: string): Promise<Policy[]> {
  if (!graphUrl) return [];
  
  const query = `
    query {
      policies(
        where: {
          isActive: true,
          isPaidOut: false,
          isExpired: false,
          retryDeadline_lt: "${Math.floor(Date.now() / 1000)}"
        }
        first: 100
        orderBy: retryDeadline
        orderDirection: asc
      ) {
        id
        chainId
        policyId
        contract
        buyer
        seller
        amount
        premium
        retryDeadline
      }
    }
  `;

  const res = await fetch(graphUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  return json.data?.policies ?? [];
}
