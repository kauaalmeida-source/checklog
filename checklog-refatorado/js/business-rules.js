export const HORA_MS = 3_600_000;

function normalizarTexto(valor) {
    return String(valor || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function valorTimestamp(registro = {}) {
    const timestampMs = Number(registro.timestampMs);
    if (Number.isFinite(timestampMs) && timestampMs > 0) return timestampMs;
    const legado = Date.parse(registro.timestamp || '');
    return Number.isFinite(legado) ? legado : 0;
}

function dataLocalISO(data) {
    const y = data.getFullYear();
    const m = String(data.getMonth() + 1).padStart(2, '0');
    const d = String(data.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function dataHoraLocalEstrita(dataISO, horario) {
    const dataPartes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dataISO || ''));
    const horaPartes = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(horario || ''));
    if (!dataPartes || !horaPartes) return null;

    const [, anoTexto, mesTexto, diaTexto] = dataPartes;
    const [, horaTexto, minutoTexto] = horaPartes;
    const ano = Number(anoTexto);
    const mes = Number(mesTexto);
    const dia = Number(diaTexto);
    const hora = Number(horaTexto);
    const minuto = Number(minutoTexto);
    const dataHora = new Date(ano, mes - 1, dia, hora, minuto, 0, 0);

    const corresponde = dataHora.getFullYear() === ano &&
        dataHora.getMonth() === mes - 1 &&
        dataHora.getDate() === dia &&
        dataHora.getHours() === hora &&
        dataHora.getMinutes() === minuto;
    return corresponde ? dataHora : null;
}

function turnoNormalizado(turno) {
    return normalizarTexto(turno);
}

function turnoDoRegistro(registro = {}) {
    return registro.turno || registro.tipo || '';
}

export function dataOperacionalISO(registroOuData, turnoInformado = '') {
    const registro = registroOuData instanceof Date
        ? { timestampMs: registroOuData.getTime(), turno: turnoInformado }
        : (registroOuData || {});
    const timestamp = valorTimestamp(registro);
    if (!timestamp) return '';

    const data = new Date(timestamp);
    const turno = turnoNormalizado(turnoDoRegistro(registro) || turnoInformado);
    if (turno.includes('noturn') && data.getHours() < 12) {
        data.setDate(data.getDate() - 1);
    }
    return dataLocalISO(data);
}

export function movimentoParaChave(valor) {
    return normalizarTexto(valor)
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

export function chaveDeterministicaPonto(uid, dataOperacional, movimento) {
    return `${uid}_${String(dataOperacional || '').replace(/-/g, '')}_${movimentoParaChave(movimento)}`;
}

export function chaveDoRegistroPonto(registro = {}) {
    const identidade = registro.uid || registro.matricula || '';
    const data = dataOperacionalISO(registro);
    if (!identidade || !data || !registro.momento) return '';
    return chaveDeterministicaPonto(identidade, data, registro.momento);
}

export function horarioInicioTurnoMinutos(registro = {}) {
    const turno = turnoNormalizado(turnoDoRegistro(registro));
    if (turno === 'administrativo') return 8 * 60;
    if (turno === 'manha') return 8 * 60;
    if (turno === 'tarde') return 14 * 60;
    if (turno === 'noturno') return 22 * 60;
    return null;
}

export function registroEntradaAtrasada(registro = {}, toleranciaMinutos = 10) {
    if (movimentoNormalizado(registro) !== 'entrada') return false;
    const inicio = horarioInicioTurnoMinutos(registro);
    const timestamp = valorTimestamp(registro);
    if (inicio === null || !timestamp) return false;
    const data = new Date(timestamp);
    const minutos = data.getHours() * 60 + data.getMinutes();
    return minutos > inicio + toleranciaMinutos;
}

export function movimentoNormalizado(registro = {}) {
    return normalizarTexto(registro.momento);
}

export function registroAbreJornada(registro = {}) {
    return ['entrada', 'volta do almoco'].includes(movimentoNormalizado(registro));
}

export function registroFechaJornada(registro = {}) {
    return ['saida para almoco', 'saida'].includes(movimentoNormalizado(registro));
}

export function registroEncerraDia(registro = {}) {
    return movimentoNormalizado(registro) === 'saida';
}

export function validarSequenciaRegistros(registrosDia) {
    const ordenados = [...registrosDia]
        .filter(valorTimestamp)
        .sort((a, b) => valorTimestamp(a) - valorTimestamp(b));
    const anteriores = [];

    for (const registro of ordenados) {
        const movimento = movimentoNormalizado(registro);
        const ultimo = anteriores[anteriores.length - 1];

        if (!ultimo) {
            if (movimento !== 'entrada') {
                return 'O primeiro movimento do dia precisa ser Entrada.';
            }
            anteriores.push(registro);
            continue;
        }

        const atual = movimentoNormalizado(ultimo);
        const permitidos = {
            entrada: ['saida para almoco', 'saida'],
            'saida para almoco': ['volta do almoco'],
            'volta do almoco': ['saida']
        };

        if (atual === 'saida') {
            return 'Este colaborador já encerrou o turno neste dia.';
        }
        if (!permitidos[atual]?.includes(movimento)) {
            return `Movimento inválido após ${ultimo.momento || 'registro não identificado'}.`;
        }
        anteriores.push(registro);
    }

    return null;
}

export function calcularTempoTrabalhadoMs(registros, agora = new Date()) {
    let inicio = null;
    let turnoInicio = '';
    let total = 0;

    [...registros]
        .filter(valorTimestamp)
        .sort((a, b) => valorTimestamp(a) - valorTimestamp(b))
        .forEach(registro => {
            const data = new Date(valorTimestamp(registro));
            if (registroAbreJornada(registro)) {
                inicio = data;
                turnoInicio = turnoDoRegistro(registro);
            }
            if (registroFechaJornada(registro) && inicio) {
                total += Math.max(0, data - inicio);
                inicio = null;
                turnoInicio = '';
            }
        });

    if (inicio && dataOperacionalISO(inicio, turnoInicio) === dataOperacionalISO(agora, turnoInicio)) {
        total += Math.max(0, agora - inicio);
    }
    return total;
}

function validarRegistroOrigem(pedido, registroOrigem) {
    if (!registroOrigem || registroOrigem.key !== pedido.registroOrigemKey) {
        throw new Error('O registro original não está mais disponível.');
    }
    const uidDivergente = pedido.uid && registroOrigem.uid && pedido.uid !== registroOrigem.uid;
    const matriculaDivergente = pedido.matricula &&
        registroOrigem.matricula &&
        String(pedido.matricula) !== String(registroOrigem.matricula);
    const possuiVinculo = (pedido.uid && registroOrigem.uid) ||
        (pedido.matricula && registroOrigem.matricula);

    if (!possuiVinculo || uidDivergente || matriculaDivergente) {
        throw new Error('O registro original não pertence ao funcionário da solicitação.');
    }
}

export function resolverRegistroOrigemJustificativa(pedido, registrosDoDia) {
    if (pedido?.registroOrigemKey) {
        return registrosDoDia.find(item => item.key === pedido.registroOrigemKey) || null;
    }
    const movimento = normalizarTexto(pedido?.movimento);
    const candidatos = registrosDoDia.filter(item => {
        const mesmoUid = pedido?.uid && item.uid && pedido.uid === item.uid;
        const mesmaMatricula = pedido?.matricula &&
            item.matricula &&
            String(pedido.matricula) === String(item.matricula);
        return (mesmoUid || mesmaMatricula) && movimentoNormalizado(item) === movimento;
    });
    return candidatos.length === 1 ? candidatos[0] : null;
}

export function resolverRegistroOrigemNoHistorico(pedido, registrosFuncionario = []) {
    const registros = Array.isArray(registrosFuncionario) ? registrosFuncionario : [];
    if (pedido?.registroOrigemKey) {
        return resolverRegistroOrigemJustificativa(pedido, registros);
    }

    const registrosDaDataCivil = registros.filter(registro => {
        const timestamp = valorTimestamp(registro);
        return timestamp && dataLocalISO(new Date(timestamp)) === pedido?.data;
    });
    return resolverRegistroOrigemJustificativa(pedido, registrosDaDataCivil);
}

export function prepararAplicacaoJustificativa({
    pedido,
    registroOrigem = null,
    registrosDoDia = [],
    responsavelEmail = '',
    decididoEm = new Date().toISOString()
}) {
    if (!pedido?.key || !pedido.uid || !pedido.matricula) {
        throw new Error('A solicitação não possui identificação suficiente.');
    }
    const dataHora = dataHoraLocalEstrita(pedido.data, pedido.horario);
    if (!dataHora) {
        throw new Error('A data ou o horário solicitado é inválido.');
    }

    const baseAjuste = {
        momento: pedido.movimento,
        timestamp: dataHora.toISOString(),
        timestampMs: dataHora.getTime(),
        ajusteManual: true,
        origem: 'justificativa',
        justificativaKey: pedido.key,
        ajustadoPor: responsavelEmail,
        ajustadoEm: decididoEm
    };

    let tipo = 'criacao';
    let registroKey = null;
    let anterior = null;
    let registro;
    let sequencia;
    let datasValidar;

    if (pedido.registroOrigemKey) {
        validarRegistroOrigem(pedido, registroOrigem);
        tipo = 'edicao';
        registroKey = registroOrigem.key;
        anterior = registroOrigem;
        registro = { ...registroOrigem, ...baseAjuste };
        sequencia = [
            ...registrosDoDia.filter(item => item.key !== registroOrigem.key),
            registro
        ];
        datasValidar = new Set([
            dataOperacionalISO(registroOrigem),
            dataOperacionalISO(registro)
        ]);
    } else {
        registro = {
            uid: pedido.uid,
            nome: pedido.nome || '',
            matricula: String(pedido.matricula),
            setor: pedido.setor || '',
            cargo: pedido.cargo || '',
            tipo: pedido.turno || 'Administrativo',
            turno: pedido.turno || 'Administrativo',
            ...baseAjuste
        };
        sequencia = [...registrosDoDia, registro];
        datasValidar = new Set([dataOperacionalISO(registro)]);
    }

    for (const data of datasValidar) {
        const registrosData = sequencia.filter(item =>
            valorTimestamp(item) &&
            dataOperacionalISO(item) === data
        );
        const erroSequencia = validarSequenciaRegistros(registrosData);
        if (erroSequencia) {
            throw new Error(`Ajuste recusado pela validação de sequência em ${data}: ${erroSequencia}`);
        }
    }

    return { tipo, registroKey, anterior, registro };
}

export function jornadaEsperadaMs(data) {
    const referencia = data instanceof Date
        ? data
        : new Date(`${data}T12:00:00`);
    const diaSemana = referencia.getDay();

    if (diaSemana >= 1 && diaSemana <= 4) return 9 * HORA_MS;
    if (diaSemana === 5) return 8 * HORA_MS;
    return 0;
}

export function saldoBancoHorasMs(dias) {
    return dias.reduce((saldo, dia) => {
        if (!dia.encerrado) return saldo;
        return saldo + Number(dia.trabalhadoMs || 0) - jornadaEsperadaMs(dia.data);
    }, 0);
}

export function processamentoJustificativaExpirado(
    justificativa,
    agora = Date.now(),
    limiteMs = 5 * 60 * 1000
) {
    if (justificativa?.status !== 'Processando') return false;
    const decididoEm = Date.parse(justificativa.decididoEm || '');
    const agoraMs = agora instanceof Date ? agora.getTime() : Number(agora);
    return Number.isFinite(decididoEm) &&
        Number.isFinite(agoraMs) &&
        agoraMs - decididoEm >= limiteMs;
}

export function sessaoAutenticadaAtual(usuarioEsperado, usuarioAtual, revisaoEsperada, revisaoAtual) {
    return Boolean(
        usuarioEsperado?.uid &&
        usuarioAtual?.uid === usuarioEsperado.uid &&
        revisaoEsperada === revisaoAtual
    );
}

export function snapshotParaLista(snapshot, mapear) {
    const itens = [];
    snapshot.forEach(child => {
        itens.push(mapear(child));
        return false;
    });
    return itens;
}
