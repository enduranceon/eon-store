import { Input } from '@/components/ui/input';
import { formatPhoneInput, isValidPhone, normalizePhone } from '@/lib/phone';
import { cn } from '@/lib/utils';

/**
 * Input de telefone com máscara progressiva (libphonenumber-js).
 *
 * - Default: BR (formato `(48) 99604-8041`)
 * - Para outros países: usuário digita iniciando com `+` (ex: `+1 415 555 2671`)
 *
 * O `value` interno é a string formatada (como o usuário vê).
 * Use `normalizePhone(value)` no submit para obter o E.164 (`+5548996048041`).
 */
export function PhoneInput({
  value,
  onChange,
  defaultCountry = 'BR',
  showError = false,
  className,
  ...rest
}) {
  const handleChange = (e) => {
    const formatted = formatPhoneInput(e.target.value, defaultCountry);
    onChange(formatted);
  };

  const invalid = showError && value && !isValidPhone(value, defaultCountry);

  return (
    <Input
      type="tel"
      inputMode="tel"
      value={value || ''}
      onChange={handleChange}
      className={cn(invalid && 'border-red-400 focus-visible:ring-red-300', className)}
      placeholder="(11) 99999-9999"
      {...rest}
    />
  );
}

export { normalizePhone, isValidPhone };
