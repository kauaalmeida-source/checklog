import {
    calcularTempoTrabalhadoMs,
    dataOperacionalISO,
    jornadaEsperadaMs,
    registroEncerraDia
} from './business-rules.js?v=1.5.2';

const MINUTO_MS = 60_000;
const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;

export const CABECALHOS_PONTO_POWER_BI = Object.freeze([
    'data',
    'funcionario_id',
    'funcionario_nome',
    'matricula',
    'setor',
    'turno',
    'minutos_trabalhados',
    'minutos_esperados',
    'saldo_minutos',
    'jornada_encerrada',
    'quantidade_registros'
]);

export const CABECALHOS_ESTOQUE_POWER_BI = Object.freeze([
    'produto_id',
    'produto',
    'categoria',
    'quantidade_atual',
    'estoque_minimo',
    'custo_unitario',
    'preco_venda',
    'valor_total_custo',
    'margem_unitaria',
    'situacao_estoque',
    'exportado_em'
]);

export const CABECALHOS_MOVIMENTOS_POWER_BI = Object.freeze([
    'movimento_id',
    'data_hora',
    'produto_id',
    'produto',
    'categoria',
    'tipo',
    'quantidade',
    'saldo_anterior',
    'saldo_atual',
    'destinatario_id',
    'destinatario_nome',
    'destinatario_matricula',
    'operador_id',
    'operador_nome',
    'operador_matricula',
    'observacao'
]);

function timestampMs(item = {}) {
    const numeric = Number(item.timestampMs);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;

    const parsed = Date.parse(item.timestamp || '');
    return Number.isFinite(parsed) ? parsed : 0;
}

function localDateIso(value) {
    const date = value instanceof Date ? value : new Date(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function identity(item = {}, fallback = '') {
    return String(item.uid || item.matricula || item.nome || fallback);
}

function stableHash(value) {
    const bytes = new TextEncoder().encode(
        String(value).trim().normalize('NFKC')
    );
    let hash = FNV_OFFSET_64;

    bytes.forEach(byte => {
        hash ^= BigInt(byte);
        hash = BigInt.asUintN(64, hash * FNV_PRIME_64);
    });

    return hash.toString(36).toUpperCase().padStart(13, '0');
}

function pseudonymMap(values, prefix = 'COLAB') {
    const unique = [...new Set(values.filter(Boolean))];

    return new Map(unique.map(value => [
        value,
        `${prefix}-${stableHash(`checklog:${prefix}:${value}`)}`
    ]));
}

function firstNonEmpty(items, select) {
    return items
        .map(select)
        .find(value => String(value ?? '').trim()) ?? '';
}

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function monetaryNumber(value) {
    const number = finiteNumber(value);
    const rounded = Math.round((Math.abs(number) + Number.EPSILON) * 100) / 100;
    return Math.sign(number) * rounded;
}

function optionalFiniteNumber(value) {
    return value === undefined || value === null || value === ''
        ? ''
        : finiteNumber(value);
}

function movementId(movement, index) {
    return movement.movimentoKey || movement.key ||
        movement.id || `movimento-${index}`;
}

function movementPersonIdentity(movement, role) {
    const person = {
        uid: movement[`${role}Uid`],
        matricula: movement[`${role}Matricula`],
        nome: movement[`${role}Nome`]
    };
    const hasIdentity = [person.uid, person.matricula, person.nome]
        .some(value => String(value ?? '').trim());

    return hasIdentity ? identity(person) : '';
}

export function filtrarPorPeriodoPowerBi(items, periodo = 'mes_atual', agora = new Date()) {
    const end = agora.getTime();
    let start = Number.NEGATIVE_INFINITY;

    if (periodo === 'mes_atual') {
        start = new Date(agora.getFullYear(), agora.getMonth(), 1).getTime();
    } else if (periodo === '90_dias') {
        const firstDay = new Date(
            agora.getFullYear(),
            agora.getMonth(),
            agora.getDate() - 89
        );
        firstDay.setHours(0, 0, 0, 0);
        start = firstDay.getTime();
    } else if (periodo !== 'historico') {
        throw new Error('Período de exportação inválido.');
    }

    const valid = [];
    let ignorados = 0;

    items.forEach(item => {
        const value = timestampMs(item);
        if (!value) {
            ignorados += 1;
            return;
        }
        if (value >= start && value <= end) valid.push(item);
    });

    return { items: valid, ignorados };
}

function filtrarPontoPorPeriodoOperacional(items, periodo, agora) {
    const end = agora.getTime();
    let startDate = '';

    if (periodo === 'mes_atual') {
        startDate = localDateIso(new Date(agora.getFullYear(), agora.getMonth(), 1));
    } else if (periodo === '90_dias') {
        startDate = localDateIso(new Date(
            agora.getFullYear(),
            agora.getMonth(),
            agora.getDate() - 89
        ));
    } else if (periodo !== 'historico') {
        throw new Error('Período de exportação inválido.');
    }

    const itemsValidos = [];
    let ignorados = 0;

    items.forEach(item => {
        const timestamp = timestampMs(item);
        if (!timestamp) {
            ignorados += 1;
            return;
        }

        const dataOperacional = dataOperacionalISO(item);
        if (!dataOperacional) {
            ignorados += 1;
            return;
        }

        if (timestamp <= end && (!startDate || dataOperacional >= startDate)) {
            itemsValidos.push(item);
        }
    });

    return { items: itemsValidos, ignorados };
}

export function montarResumoPontoPowerBi(registros, {
    periodo = 'mes_atual',
    privacidade = 'pseudonimizado',
    agora = new Date()
} = {}) {
    const filtered = filtrarPontoPorPeriodoOperacional(registros, periodo, agora);
    const groups = new Map();

    filtered.items.forEach((registro, index) => {
        const person = identity(registro, `registro-${registro.key || index}`);
        const date = dataOperacionalISO(registro);
        const key = `${person}|${date}`;

        if (!groups.has(key)) {
            groups.set(key, { person, date, registros: [] });
        }
        groups.get(key).registros.push(registro);
    });

    const pseudonyms = pseudonymMap([...groups.values()].map(group => group.person));
    const identified = privacidade === 'identificado';
    const linhas = [...groups.values()]
        .sort((a, b) =>
            a.date.localeCompare(b.date) ||
            a.person.localeCompare(b.person, 'pt-BR')
        )
        .map(group => {
            const ordered = [...group.registros]
                .sort((a, b) => timestampMs(a) - timestampMs(b));
            const closed = registroEncerraDia(ordered[ordered.length - 1]);
            const worked = Math.round(
                calcularTempoTrabalhadoMs(ordered, agora) / MINUTO_MS
            );
            const expected = Math.round(
                jornadaEsperadaMs(group.date) / MINUTO_MS
            );
            const name = firstNonEmpty(ordered, item => item.nome);
            const registration = firstNonEmpty(ordered, item => item.matricula);
            const department = firstNonEmpty(ordered, item => item.setor);
            const shift = firstNonEmpty(ordered, item => item.turno || item.tipo);

            return [
                group.date,
                pseudonyms.get(group.person),
                identified ? name : '',
                identified ? String(registration) : '',
                department,
                shift,
                worked,
                expected,
                closed ? worked - expected : '',
                closed,
                ordered.length
            ];
        });

    return {
        nomeArquivo: `checklog-powerbi-ponto-${localDateIso(agora)}.csv`,
        cabecalhos: [...CABECALHOS_PONTO_POWER_BI],
        linhas,
        ignorados: filtered.ignorados
    };
}

export function montarPosicaoEstoquePowerBi(produtos, {
    agora = new Date()
} = {}) {
    const exportadoEm = agora.toISOString();
    const linhas = [...produtos]
        .sort((a, b) =>
            String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR')
        )
        .map(produto => {
            const quantidade = finiteNumber(produto.qty);
            const estoqueMinimo = finiteNumber(produto.minQty);
            const custo = monetaryNumber(produto.price);
            const venda = monetaryNumber(produto.salePrice);
            let situacao = 'normal';

            if (quantidade <= estoqueMinimo) {
                situacao = 'critico';
            } else if (quantidade <= estoqueMinimo * 1.5) {
                situacao = 'atencao';
            }

            return [
                String(produto.key || produto.id || ''),
                String(produto.name || ''),
                String(produto.category || ''),
                quantidade,
                estoqueMinimo,
                custo,
                venda,
                monetaryNumber(quantidade * custo),
                monetaryNumber(venda - custo),
                situacao,
                exportadoEm
            ];
        });

    return {
        nomeArquivo: `checklog-powerbi-estoque-${localDateIso(agora)}.csv`,
        cabecalhos: [...CABECALHOS_ESTOQUE_POWER_BI],
        linhas,
        ignorados: 0
    };
}

export function montarMovimentacoesEstoquePowerBi(movimentos, {
    periodo = 'mes_atual',
    privacidade = 'pseudonimizado',
    agora = new Date()
} = {}) {
    const filtered = filtrarPorPeriodoPowerBi(movimentos, periodo, agora);
    const ordered = [...filtered.items]
        .sort((a, b) => timestampMs(a) - timestampMs(b));
    const identities = ordered.flatMap((movimento, index) => {
        return [
            movementPersonIdentity(movimento, 'destinatario'),
            movementPersonIdentity(movimento, 'operador')
        ];
    });
    const pseudonyms = pseudonymMap(identities, 'PESSOA');
    const identified = privacidade === 'identificado';
    const linhas = ordered.map((movimento, index) => {
        const id = movementId(movimento, index);
        const destinatario = movementPersonIdentity(movimento, 'destinatario');
        const operador = movementPersonIdentity(movimento, 'operador');

        return [
            String(id),
            new Date(timestampMs(movimento)).toISOString(),
            String(movimento.produtoKey || movimento.produtoId || ''),
            String(movimento.name || ''),
            String(movimento.category || ''),
            String(movimento.tipo || ''),
            finiteNumber(movimento.qty),
            optionalFiniteNumber(movimento.saldoAnterior),
            optionalFiniteNumber(movimento.saldoAtual),
            destinatario ? pseudonyms.get(destinatario) : '',
            identified ? String(movimento.destinatarioNome || '') : '',
            identified ? String(movimento.destinatarioMatricula || '') : '',
            operador ? pseudonyms.get(operador) : '',
            identified ? String(movimento.operadorNome || '') : '',
            identified ? String(movimento.operadorMatricula || '') : '',
            identified ? String(movimento.observacao || '') : ''
        ];
    });

    return {
        nomeArquivo: `checklog-powerbi-movimentacoes-${localDateIso(agora)}.csv`,
        cabecalhos: [...CABECALHOS_MOVIMENTOS_POWER_BI],
        linhas,
        ignorados: filtered.ignorados
    };
}

export function serializarCsv(cabecalhos, linhas, {
    separador = ';',
    preservarNumeros = false
} = {}) {
    if (![';', ','].includes(separador)) {
        throw new Error('Separador CSV inválido.');
    }

    const escapar = valor => {
        const numeric = preservarNumeros && typeof valor === 'number' && Number.isFinite(valor);
        const raw = String(valor ?? '');
        const safe = !numeric && /^[=+\-@]/.test(raw.trimStart()) ? `'${raw}` : raw;
        return `"${safe.replace(/"/g, '""')}"`;
    };
    const content = [cabecalhos, ...linhas]
        .map(row => row.map(escapar).join(separador))
        .join('\r\n');
    return `\uFEFF${content}`;
}

export function montarDatasetPowerBi(tipo, {
    registrosPonto = [],
    produtos = [],
    movimentos = []
} = {}, opcoes = {}) {
    if (tipo === 'ponto') return montarResumoPontoPowerBi(registrosPonto, opcoes);
    if (tipo === 'estoque') return montarPosicaoEstoquePowerBi(produtos, opcoes);
    if (tipo === 'movimentacoes') return montarMovimentacoesEstoquePowerBi(movimentos, opcoes);
    throw new Error('Conjunto de dados inválido.');
}
