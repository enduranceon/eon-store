import CommunicationCaseDialog from '@/components/CommunicationCaseDialog';

// O formato de entrada antigo (task) ainda é aceito pelos pontos de entrada
// existentes. O diálogo sempre prepara/revalida o caso no servidor antes de
// sugerir texto ou registrar uma ação, sem manter um segundo escritor.
export default function CommunicationSendDialog({
  task,
  caseId,
  communicationCase,
  onClose,
  onChanged,
  onSent,
  onManualPay,
  sourceUi,
}) {
  if (!task && !caseId && !communicationCase) return null;

  return (
    <CommunicationCaseDialog
      key={caseId || communicationCase?.id || `${task?.sourceType || task?.source_type}:${task?.sourceId || task?.source_id}`}
      task={task}
      caseId={caseId || communicationCase?.id}
      communicationCase={communicationCase}
      sourceUi={sourceUi}
      onClose={onClose}
      onChanged={onChanged}
      onSent={onSent}
      onManualPay={onManualPay}
    />
  );
}
