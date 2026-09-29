#!/usr/bin/env python3
"""Monta a transação única de um lote de migração de contratos legados.

Junta, nesta ordem, a foto dos cadastros (verify_sql.py --snapshot), os
blocos de migração (generate_sql.py) e as conferências
(verify_sql.py --assert) num único bloco DO entre BEGIN e COMMIT. A função
temporária que generate_sql.py cria antes dos blocos fica antes do DO, e
o DROP dela, depois:

- se qualquer conferência falhar, a exceção desfaz tudo;
- se o texto chegar cortado ao banco, o bloco fica sem fechamento e o
  PostgreSQL recusa a consulta inteira antes de executar qualquer parte.

Também tira comentários, linhas vazias e indentação para diminuir o texto.

Uso:
  python3 build_run_sql.py <snapshot.sql> <migracao.sql> <conferencia.sql>
"""
import re
import sys

OUTER_TAG = "migration_batch"
DO_OPEN = re.compile(r"^DO \$(\w+)\$$")
DO_CLOSE = re.compile(r"^END \$(\w+)\$;$")


def compact_lines(text, source):
    lines = []
    for n, line in enumerate(text.splitlines(), 1):
        body = line.strip()
        if not body or body.startswith("--"):
            continue
        # literal de texto atravessando linhas teria a indentação alterada
        if body.count("'") % 2:
            raise SystemExit(f"{source}:{n}: aspas ímpares, possível literal multilinha")
        if f"${OUTER_TAG}$" in body:
            raise SystemExit(f"{source}:{n}: usa o delimitador reservado ${OUTER_TAG}$")
        lines.append(body)
    return lines


def split_prelude(lines, source):
    """Separa o que vem antes do primeiro DO e depois do último END $tag$;."""
    first = next((i for i, l in enumerate(lines) if DO_OPEN.match(l)), None)
    last = max((i for i, l in enumerate(lines) if DO_CLOSE.match(l)), default=None)
    if first is None or last is None:
        raise SystemExit(f"{source}: nenhum bloco DO")
    return lines[:first], lines[first:last + 1], lines[last + 1:]


def nest_do_blocks(lines, source):
    """Transforma cada `DO $tag$ ... END $tag$;` em sub-bloco `... END;`."""
    out, open_tag = [], None
    for line in lines:
        opened, closed = DO_OPEN.match(line), DO_CLOSE.match(line)
        if opened:
            if open_tag:
                raise SystemExit(f"{source}: DO ${opened.group(1)}$ dentro de ${open_tag}$")
            open_tag = opened.group(1)
            continue
        if closed:
            if closed.group(1) != open_tag:
                raise SystemExit(f"{source}: END ${closed.group(1)}$ sem DO correspondente")
            open_tag = None
            out.append("END;")
            continue
        if open_tag is None:
            raise SystemExit(f"{source}: comando fora de bloco DO: {line[:80]}")
        if re.search(r"\$\w*\$", line):
            raise SystemExit(f"{source}: literal com $...$ dentro do bloco: {line[:80]}")
        out.append(line)
    if open_tag:
        raise SystemExit(f"{source}: bloco ${open_tag}$ sem fechamento")
    return out


def main():
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    snapshot_path, migration_path, assert_path = sys.argv[1:]

    snapshot = compact_lines(open(snapshot_path).read(), snapshot_path)
    if not snapshot or not snapshot[0].startswith("CREATE TEMP TABLE"):
        raise SystemExit(f"{snapshot_path}: esperado CREATE TEMP TABLE")
    prelude, migration, epilogue = split_prelude(
        compact_lines(open(migration_path).read(), migration_path), migration_path
    )
    migration = nest_do_blocks(migration, migration_path)
    checks = nest_do_blocks(
        compact_lines(open(assert_path).read(), assert_path), assert_path
    )

    print("BEGIN;")
    if prelude:
        print("\n".join(prelude))
    print(f"DO ${OUTER_TAG}$")
    print("BEGIN")
    print("\n".join(snapshot))
    print("\n".join(migration))
    print("\n".join(checks))
    print(f"END ${OUTER_TAG}$;")
    if epilogue:
        print("\n".join(epilogue))
    print("COMMIT;")


if __name__ == "__main__":
    main()
