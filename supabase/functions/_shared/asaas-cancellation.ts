import {
  AsaasApiError,
  deleteAsaasInstallmentPayments,
  deleteAsaasPayment,
  getAsaasInstallmentPayments,
  getAsaasPayment,
} from "./asaas.ts";

const CANCELLABLE_ASAAS_STATUSES = new Set(["PENDING", "OVERDUE"]);
const INACTIVE_ASAAS_STATUSES = new Set([
  "FAILED",
  "CANCELLED",
  "CANCELED",
]);
const CANCELLED_ASAAS_STATUSES = new Set(["CANCELLED", "CANCELED"]);

export interface AsaasCancellationSnapshot {
  provider: "asaas";
  payment_id: string;
  kind: "standalone" | "installment";
  installment_id?: string;
  installment_group_id?: string;
}

type PersistSnapshot = (
  snapshot: AsaasCancellationSnapshot,
) => Promise<void>;

export async function cancelExternalCharge(
  chargeId: string,
  knownInstallmentId = "",
  knownStandalone = false,
  knownPaymentIds: string[] = [],
  persistSnapshot?: PersistSnapshot,
): Promise<Record<string, unknown>> {
  const savedPaymentIds = Array.from(
    new Set([...knownPaymentIds.filter(Boolean), chargeId]),
  );
  const lookup = await getAsaasPayment(chargeId);

  if (!lookup.found && !knownInstallmentId) {
    if (!knownStandalone) {
      throw new AsaasApiError(
        "A cobrança principal não foi encontrada e o conjunto de parcelas precisa de conferência",
        409,
        "asaas_charge_missing_unconfirmed",
      );
    }
    await persistSnapshot?.({
      provider: "asaas",
      payment_id: chargeId,
      kind: "standalone",
    });
    return {
      provider: "asaas",
      outcome: "already_missing",
      payment_id: chargeId,
      payment_ids: savedPaymentIds,
      previous_status: "NOT_FOUND",
    };
  }

  const installmentId = lookup.found &&
      typeof lookup.payment.installment === "string"
    ? lookup.payment.installment
    : knownInstallmentId;

  if (
    lookup.found && knownInstallmentId && installmentId !== knownInstallmentId
  ) {
    throw new AsaasApiError(
      "O grupo da cobrança diverge do registro local",
      409,
      "asaas_installment_mismatch",
    );
  }
  if (lookup.found && knownStandalone && installmentId) {
    throw new AsaasApiError(
      "A cobrança registrada como avulsa pertence a um parcelamento",
      409,
      "asaas_installment_mismatch",
    );
  }

  await persistSnapshot?.(
    installmentId
      ? {
        provider: "asaas",
        payment_id: chargeId,
        kind: "installment",
        installment_id: installmentId,
        installment_group_id: installmentId,
      }
      : {
        provider: "asaas",
        payment_id: chargeId,
        kind: "standalone",
      },
  );

  if (
    lookup.found && CANCELLED_ASAAS_STATUSES.has(lookup.status) &&
    !installmentId
  ) {
    return {
      provider: "asaas",
      outcome: "already_cancelled",
      payment_id: chargeId,
      payment_ids: savedPaymentIds,
      previous_status: lookup.status,
    };
  }

  if (
    lookup.found && !CANCELLABLE_ASAAS_STATUSES.has(lookup.status) &&
    !INACTIVE_ASAAS_STATUSES.has(lookup.status)
  ) {
    throw new AsaasApiError(
      `A cobrança está com status ${lookup.status} e exige conferência antes do cancelamento`,
      409,
      "asaas_status_not_cancellable",
    );
  }

  if (installmentId) {
    const payments = await getAsaasInstallmentPayments(installmentId);
    const providerPaymentIds = payments.map((payment) =>
      typeof payment.id === "string" ? payment.id : ""
    );
    if (
      providerPaymentIds.some((paymentId) => !paymentId) ||
      new Set(providerPaymentIds).size !== providerPaymentIds.length ||
      payments.some((payment) => payment.installment !== installmentId) ||
      (lookup.found && payments.length > 0 &&
        !providerPaymentIds.includes(chargeId))
    ) {
      throw new AsaasApiError(
        "O Asaas devolveu um conjunto de parcelas inconsistente",
        409,
        "asaas_installment_mismatch",
      );
    }
    const paymentIds = Array.from(
      new Set([...savedPaymentIds, ...providerPaymentIds]),
    );
    if (
      payments.length === 0 &&
      (!lookup.found || CANCELLED_ASAAS_STATUSES.has(lookup.status))
    ) {
      return {
        provider: "asaas",
        outcome: lookup.found ? "already_cancelled" : "already_missing",
        payment_id: chargeId,
        payment_ids: paymentIds,
        previous_status: lookup.found ? lookup.status : "NOT_FOUND",
        installment_id: installmentId,
        installment_group_id: installmentId,
        installment_payments: 0,
      };
    }
    if (
      payments.length === 0 ||
      payments.some((payment) => {
        const status = typeof payment.status === "string"
          ? payment.status
          : "UNKNOWN";
        return !CANCELLABLE_ASAAS_STATUSES.has(status) &&
          !INACTIVE_ASAAS_STATUSES.has(status);
      })
    ) {
      throw new AsaasApiError(
        "O parcelamento possui cobranças que exigem conferência antes do cancelamento",
        409,
        "asaas_installment_not_cancellable",
      );
    }
    const outcome = await deleteAsaasInstallmentPayments(installmentId);
    return {
      provider: "asaas",
      outcome,
      payment_id: chargeId,
      payment_ids: paymentIds,
      previous_status: lookup.found ? lookup.status : "NOT_FOUND",
      installment_id: installmentId,
      installment_group_id: installmentId,
      installment_payments: payments.length,
    };
  }

  const outcome = await deleteAsaasPayment(chargeId);
  return {
    provider: "asaas",
    outcome,
    payment_id: chargeId,
    payment_ids: savedPaymentIds,
    previous_status: lookup.found ? lookup.status : "NOT_FOUND",
  };
}
