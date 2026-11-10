// Gráficos da área do coach. Dois só, de leitura direta:
//  - BaseTrend: quantos alunos ativos havia no fim de cada mês (uma linha, sem dois eixos);
//  - FlowChart: quem entrou (para cima) e quem saiu (para baixo) em cada mês.
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';

const monthName = label => String(label || '').split('/')[0];

function TooltipBox({ title, rows }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-semibold text-slate-900">{title}</p>
      {rows.map(([label, value, dot]) => (
        <p key={label} className="flex items-center justify-between gap-4 text-slate-600">
          <span className="inline-flex items-center gap-1.5">
            {dot && <span className="h-2 w-2 rounded-full" style={{ background: dot }} aria-hidden="true" />}
            {label}
          </span>
          <b className="tabular-nums text-slate-900">{value}</b>
        </p>
      ))}
    </div>
  );
}

function BaseTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return <TooltipBox title={row.label} rows={[['Alunos ativos', row.base, '#2563eb']]} />;
}

function FlowTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <TooltipBox
      title={row.label}
      rows={[
        ['Entradas', row.entries, '#10b981'],
        ['Retornos', row.returns, '#6ee7b7'],
        ['Saídas', row.exits, '#f43f5e'],
        ['Alunos no fim do mês', row.base, null],
      ]}
    />
  );
}

const rowsOf = monthly => monthly.map(month => ({
  label: month.label,
  short: monthName(month.label),
  base: month.base_end,
  entries: month.entries,
  returns: month.returns,
  exits: month.exits,
  negativeExits: -month.exits,
}));

// `tone="dark"` desenha em branco sobre o fundo escuro do cartão de destaque.
export function BaseTrend({ monthly, tone = 'light', height = 160, ariaLabel }) {
  const data = rowsOf(monthly);
  const dark = tone === 'dark';
  const stroke = dark ? '#ffffff' : '#2563eb';
  const gradientId = `base-fill-${tone}`;
  const last = data[data.length - 1];
  const values = data.map(row => row.base);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(1, Math.round((max - min) * 0.25));
  return (
    <div style={{ height }} role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 8, left: dark ? 8 : -18, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={dark ? 0.35 : 0.25} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          {!dark && <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />}
          <XAxis dataKey="short" interval={0} hide={dark} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
          <YAxis hide={dark} domain={[Math.max(0, min - pad), max + pad]} allowDecimals={false} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} width={40} />
          <Tooltip content={<BaseTooltip />} cursor={{ stroke, strokeOpacity: 0.3 }} />
          <Area type="monotone" dataKey="base" stroke={stroke} strokeWidth={2.5} fill={`url(#${gradientId})`} dot={false} activeDot={{ r: 4, fill: stroke, stroke: dark ? '#1e1b4b' : '#fff', strokeWidth: 2 }} isAnimationActive={false} />
          {last && <ReferenceDot x={last.short} y={last.base} r={4.5} fill={stroke} stroke={dark ? '#1e1b4b' : '#fff'} strokeWidth={2} />}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function FlowChart({ monthly, height = 220, ariaLabel }) {
  const data = rowsOf(monthly);
  const peak = Math.max(1, ...data.map(row => row.entries + row.returns), ...data.map(row => row.exits));
  return (
    <div style={{ height }} role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} stackOffset="sign" margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
          <XAxis dataKey="short" interval={0} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
          <YAxis domain={[-peak, peak]} ticks={[-peak, 0, peak]} allowDecimals={false} tickFormatter={value => Math.abs(value)} tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} width={40} />
          <ReferenceLine y={0} stroke="#94a3b8" />
          <Tooltip content={<FlowTooltip />} cursor={{ fill: '#f1f5f9' }} />
          <Bar dataKey="entries" stackId="flow" fill="#10b981" maxBarSize={22} isAnimationActive={false} />
          <Bar dataKey="returns" stackId="flow" fill="#6ee7b7" radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
          <Bar dataKey="negativeExits" stackId="flow" fill="#f43f5e" radius={[0, 0, 4, 4]} maxBarSize={22} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function FlowLegend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600" aria-label="Legenda do gráfico">
      {[['Entradas', '#10b981'], ['Retornos', '#6ee7b7'], ['Saídas', '#f43f5e']].map(([label, color]) => (
        <li key={label} className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} aria-hidden="true" />
          {label}
        </li>
      ))}
    </ul>
  );
}
