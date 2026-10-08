/**
 * Canonical x402 v2 protocol roles (Block A).
 * Запрещено как protocolRole: BUYER, SELLER, PAYER, PAYEE, INTERMEDIARY,
 * AGENT, PROVIDER, REQUESTER, COUNTERPARTY.
 *
 * ВАЖНО: protocolRole — per-scenario, НЕ глобальная роль participantId.
 * Один participantId может играть разные роли в разных сценариях
 * (sut-1: FACILITATOR в S1–S7, RESOURCE_SERVER в S8).
 * Wiring per-participant адаптеров — техническое ограничение текущей
 * реализации, не семантическое.
 */
export type ProtocolRole = 'CLIENT' | 'RESOURCE_SERVER' | 'FACILITATOR';

/**
 * Participant — любая сущность, которая действует в сценарии.
 *
 * Role ≠ Name: participantId — просто имя, не выводит protocolRole или ownership.
 * Role ≠ Ownership: protocolRole описывает что участник делает, ownership — кто им управляет.
 *
 * protocolRole OPTIONAL: отсутствие поля = app-level participant
 * (не protocol participant). Facilitator опционален в протоколе x402,
 * поэтому поле может отсутствовать в сценарии (например sut-1 в S8 —
 * прямая отдача ресурса без посредника).
 */
export interface Participant {
  participantId: string;       // просто имя, не несёт семантики
  protocolRole?: ProtocolRole; // canonical x402 roles; undefined = app-level
  ownership: 'ARGUS' | 'EXTERNAL';
}
