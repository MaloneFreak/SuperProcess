/**
 * The built-in example: a meeting about how supplier invoices get paid, and
 * the process mapped from it. It lets people explore the app before they
 * connect an AI, and gives them a realistic transcript to try the AI with.
 */
import type { SourceDocument } from '../core/import';
import { normalizeModel } from '../core/model/normalize';
import type { ProcessModel } from '../core/model/types';

type Lang = 'en' | 'pt-BR' | 'es';

const TRANSCRIPTS: Record<Lang, { name: string; text: string }> = {
  en: {
    name: 'accounts-payable-meeting.vtt',
    text: `[00:00] Marina (Process analyst): Thanks for joining. I'd like to walk through how supplier invoices get paid today, step by step.
[00:12] Paulo (Accounts payable): Sure. Invoices arrive by e-mail, most as PDF. Some suppliers still send paper, and reception scans them into our shared mailbox.
[00:31] Paulo (Accounts payable): I open each one and type the data into the ERP by hand: supplier, amount, due date, PO number. That is about five minutes per invoice, and we get roughly 600 a month.
[00:52] Marina (Process analyst): What happens if there is no purchase order number?
[00:58] Paulo (Accounts payable): Then I e-mail the person who ordered it and wait. That can take days. About one in five invoices comes without a PO.
[01:20] Paulo (Accounts payable): When I have the PO, I compare invoice, purchase order and goods receipt in the ERP. If quantities or prices don't match, I send the invoice back to the supplier by e-mail and ask for a corrected one.
[01:44] Marina (Process analyst): And if it matches?
[01:47] Paulo (Accounts payable): Then it goes for approval. Up to 10,000 the cost centre manager approves. Above that, the finance director has to approve as well.
[02:05] Carla (AP manager): Approval is by e-mail today. Managers reply "approved" and Paulo saves the e-mail in a folder. Honestly, sometimes they approve by phone or in the corridor and there is no record at all.
[02:26] Carla (AP manager): Approvals are the slowest part. Three days on average, and if the manager is travelling it can be more than a week. We paid late fees twice last quarter because of that.
[02:49] Marina (Process analyst): Who releases the payment?
[02:52] Carla (AP manager): After approval Paulo schedules the payment in the ERP. Every Tuesday and Thursday treasury generates the payment file and uploads it to the bank portal.
[03:10] Rui (Treasury): Right. I export the file from the ERP, upload it to the bank, and then a second person from treasury authorises it in the portal. The bank won't release it without two people.
[03:28] Rui (Treasury): The next day I download the bank statement and reconcile it in a spreadsheet, then mark the invoices as paid in the ERP. That reconciliation is manual and takes me about two hours each time.
[03:50] Marina (Process analyst): Any checks for duplicate invoices?
[03:54] Paulo (Accounts payable): The ERP warns if the same invoice number is typed twice for the same supplier, but if the number is typed slightly differently it goes through. We found two duplicate payments last year.
[04:15] Carla (AP manager): One more thing: Paulo both registers new suppliers and enters invoices. Audit pointed that out last year, but we are a small team.
[04:31] Marina (Process analyst): Understood. And what tells you the process is finished?
[04:36] Rui (Treasury): When the payment is reconciled and the invoice is marked as paid. At that point we send the remittance advice to the supplier by e-mail.`,
  },
  'pt-BR': {
    name: 'reuniao-contas-a-pagar.vtt',
    text: `[00:00] Marina (Analista de processos): Obrigada por participarem. Quero percorrer, passo a passo, como as notas fiscais de fornecedores são pagas hoje.
[00:12] Paulo (Contas a pagar): Claro. As notas chegam por e-mail, a maioria em PDF. Alguns fornecedores ainda mandam em papel, e a recepção digitaliza e manda para a nossa caixa compartilhada.
[00:31] Paulo (Contas a pagar): Eu abro cada uma e digito os dados no ERP na mão: fornecedor, valor, vencimento, número do pedido. Dá uns cinco minutos por nota, e recebemos mais ou menos 600 por mês.
[00:52] Marina (Analista de processos): E quando a nota vem sem número de pedido de compra?
[00:58] Paulo (Contas a pagar): Aí eu mando e-mail para quem fez a compra e fico esperando. Pode levar dias. Mais ou menos uma em cada cinco notas vem sem pedido.
[01:20] Paulo (Contas a pagar): Com o pedido em mãos, eu comparo nota, pedido de compra e recebimento no ERP. Se quantidade ou preço não batem, devolvo a nota ao fornecedor por e-mail pedindo a correção.
[01:44] Marina (Analista de processos): E se bate?
[01:47] Paulo (Contas a pagar): Aí vai para aprovação. Até 10.000 quem aprova é o gestor do centro de custo. Acima disso, o diretor financeiro também precisa aprovar.
[02:05] Carla (Gerente de contas a pagar): Hoje a aprovação é por e-mail. O gestor responde "aprovado" e o Paulo salva o e-mail numa pasta. Sinceramente, às vezes aprovam por telefone ou no corredor e não fica registro nenhum.
[02:26] Carla (Gerente de contas a pagar): A aprovação é a parte mais lenta. Três dias em média, e se o gestor está viajando pode passar de uma semana. Pagamos multa por atraso duas vezes no último trimestre por causa disso.
[02:49] Marina (Analista de processos): Quem libera o pagamento?
[02:52] Carla (Gerente de contas a pagar): Depois da aprovação o Paulo programa o pagamento no ERP. Toda terça e quinta a tesouraria gera o arquivo de pagamento e sobe no portal do banco.
[03:10] Rui (Tesouraria): Isso. Eu exporto o arquivo do ERP, envio ao banco e depois uma segunda pessoa da tesouraria autoriza no portal. O banco não libera sem duas pessoas.
[03:28] Rui (Tesouraria): No dia seguinte eu baixo o extrato e faço a conciliação numa planilha, depois marco as notas como pagas no ERP. Essa conciliação é manual e me toma umas duas horas cada vez.
[03:50] Marina (Analista de processos): Existe alguma verificação de nota duplicada?
[03:54] Paulo (Contas a pagar): O ERP avisa se o mesmo número de nota for digitado duas vezes para o mesmo fornecedor, mas se o número for digitado um pouco diferente, passa. Achamos dois pagamentos em duplicidade no ano passado.
[04:15] Carla (Gerente de contas a pagar): Mais uma coisa: o Paulo cadastra fornecedor novo e também lança as notas. A auditoria apontou isso no ano passado, mas a equipe é pequena.
[04:31] Marina (Analista de processos): Entendi. E o que indica que o processo terminou?
[04:36] Rui (Tesouraria): Quando o pagamento está conciliado e a nota marcada como paga. Nesse momento enviamos o comprovante ao fornecedor por e-mail.`,
  },
  es: {
    name: 'reunion-cuentas-por-pagar.vtt',
    text: `[00:00] Marina (Analista de procesos): Gracias por venir. Quiero repasar, paso a paso, cómo se pagan hoy las facturas de proveedores.
[00:12] Paulo (Cuentas por pagar): Claro. Las facturas llegan por correo, casi todas en PDF. Algunos proveedores todavía las envían en papel y recepción las escanea a nuestro buzón compartido.
[00:31] Paulo (Cuentas por pagar): Abro cada una y tecleo los datos en el ERP a mano: proveedor, importe, vencimiento, número de pedido. Son unos cinco minutos por factura y recibimos unas 600 al mes.
[00:52] Marina (Analista de procesos): ¿Qué pasa si no trae número de orden de compra?
[00:58] Paulo (Cuentas por pagar): Entonces escribo a quien hizo la compra y espero. Puede tardar días. Más o menos una de cada cinco facturas llega sin pedido.
[01:20] Paulo (Cuentas por pagar): Con el pedido, comparo factura, orden de compra y recepción en el ERP. Si las cantidades o los precios no coinciden, devuelvo la factura al proveedor por correo y pido una corregida.
[01:44] Marina (Analista de procesos): ¿Y si coincide?
[01:47] Paulo (Cuentas por pagar): Entonces va a aprobación. Hasta 10.000 aprueba el responsable del centro de coste. Por encima, también tiene que aprobar el director financiero.
[02:05] Carla (Jefa de cuentas por pagar): Hoy la aprobación es por correo. El responsable contesta "aprobado" y Paulo guarda el correo en una carpeta. Sinceramente, a veces aprueban por teléfono o en el pasillo y no queda ningún registro.
[02:26] Carla (Jefa de cuentas por pagar): La aprobación es lo más lento. Tres días de media, y si el responsable está de viaje puede pasar de una semana. El trimestre pasado pagamos recargos por demora dos veces por eso.
[02:49] Marina (Analista de procesos): ¿Quién libera el pago?
[02:52] Carla (Jefa de cuentas por pagar): Tras la aprobación Paulo programa el pago en el ERP. Cada martes y jueves tesorería genera el fichero de pagos y lo sube al portal del banco.
[03:10] Rui (Tesorería): Eso es. Exporto el fichero del ERP, lo subo al banco y después una segunda persona de tesorería lo autoriza en el portal. El banco no lo libera sin dos personas.
[03:28] Rui (Tesorería): Al día siguiente descargo el extracto y lo concilio en una hoja de cálculo, y luego marco las facturas como pagadas en el ERP. Esa conciliación es manual y me lleva unas dos horas cada vez.
[03:50] Marina (Analista de procesos): ¿Hay algún control de facturas duplicadas?
[03:54] Paulo (Cuentas por pagar): El ERP avisa si se teclea dos veces el mismo número de factura para el mismo proveedor, pero si el número se teclea un poco distinto, pasa. El año pasado encontramos dos pagos duplicados.
[04:15] Carla (Jefa de cuentas por pagar): Una cosa más: Paulo da de alta proveedores nuevos y también registra las facturas. Auditoría lo señaló el año pasado, pero somos un equipo pequeño.
[04:31] Marina (Analista de procesos): Entendido. ¿Y qué indica que el proceso ha terminado?
[04:36] Rui (Tesorería): Cuando el pago está conciliado y la factura marcada como pagada. En ese momento enviamos el aviso de pago al proveedor por correo.`,
  },
};

/** Every piece of text in the sample model, per language, in a fixed order. */
const TEXT: Record<Lang, Record<string, string>> = {
  en: {
    name: 'Supplier invoice payment',
    summary:
      'A supplier invoice arrives by e-mail and is keyed into the ERP. Accounts payable matches it with the purchase order and goods receipt, obtains approval according to the amount, and schedules it. Treasury pays twice a week through the bank portal, reconciles the statement and confirms the payment to the supplier.',
    pool: 'Finance department',
    ap: 'Accounts payable',
    req: 'Requester',
    mgr: 'Cost centre manager',
    cfo: 'Finance director',
    tre: 'Treasury',
    supplier: 'Supplier',
    bank: 'Bank',
    s1: 'Invoice received',
    t1: 'Register invoice in ERP',
    t1d: 'The invoice data (supplier, amount, due date, PO number) is typed into the ERP by hand.',
    t1i1: 'Manual data entry: about 5 minutes per invoice, roughly 600 invoices a month',
    t1i2: 'Duplicate check fails when the invoice number is typed differently; two duplicate payments last year',
    t1i3: 'The same person registers suppliers and enters invoices (raised by audit)',
    g1: 'PO number on invoice?',
    yes: 'Yes',
    no: 'No',
    t2: 'Ask requester for PO number',
    t2b: 'Provide PO number',
    t2bi: 'About one in five invoices arrives without a PO; the answer can take days',
    t3: 'Match invoice, PO and receipt',
    t3d: 'Three-way match of invoice, purchase order and goods receipt in the ERP.',
    g2: 'Documents match?',
    t4: 'Return invoice to supplier',
    e1: 'Invoice returned',
    t5: 'Approve invoice',
    t5d: 'The manager replies "approved" by e-mail; the e-mail is filed in a folder.',
    t5i1: 'Three days on average; more than a week when the manager is travelling',
    t5i2: 'Approvals by phone or in the corridor leave no record',
    t5i3: 'Late fees were paid twice last quarter',
    g3: 'Amount above 10,000?',
    t6: 'Approve invoice',
    t7: 'Schedule payment',
    w1: 'Tuesday or Thursday',
    t8: 'Generate payment file',
    t9: 'Upload file to bank portal',
    t10: 'Authorise payment in portal',
    t10d: 'A second person from treasury authorises the payment; the bank requires two people.',
    w2: 'Next day',
    t11: 'Reconcile bank statement',
    t11i: 'Manual reconciliation in a spreadsheet, about two hours each time',
    t12: 'Mark invoice as paid',
    t13: 'Send remittance advice',
    e2: 'Invoice paid',
    invoice: 'Invoice',
    corrected: 'Request for corrected invoice',
    payfile: 'Payment file',
    statement: 'Bank statement',
    remittance: 'Remittance advice',
    po: 'Purchase order',
    receipt: 'Goods receipt',
    email: 'E-mail',
    sheet: 'Spreadsheet',
    portal: 'Bank portal',
    d5: '5 minutes per invoice',
    days: 'days',
    d3: '3 days on average',
    d2h: 'about 2 hours',
    a1: 'What happens when an approver rejects an invoice was not discussed; no rejection path is modelled.',
    a2: 'The 10,000 threshold is assumed to apply to the invoice total.',
    q1: 'What happens when the cost centre manager or the finance director rejects an invoice?',
    q2: 'Who approves when the cost centre manager is absent?',
    q3: 'How are urgent payments handled outside the Tuesday and Thursday runs?',
  },
  'pt-BR': {
    name: 'Pagamento de notas fiscais de fornecedores',
    summary:
      'A nota fiscal do fornecedor chega por e-mail e é digitada no ERP. O contas a pagar confere a nota com o pedido de compra e o recebimento, obtém a aprovação conforme o valor e programa o pagamento. A tesouraria paga duas vezes por semana pelo portal do banco, concilia o extrato e confirma o pagamento ao fornecedor.',
    pool: 'Departamento Financeiro',
    ap: 'Contas a pagar',
    req: 'Solicitante',
    mgr: 'Gestor do centro de custo',
    cfo: 'Diretor financeiro',
    tre: 'Tesouraria',
    supplier: 'Fornecedor',
    bank: 'Banco',
    s1: 'Nota fiscal recebida',
    t1: 'Lançar nota no ERP',
    t1d: 'Os dados da nota (fornecedor, valor, vencimento, número do pedido) são digitados manualmente no ERP.',
    t1i1: 'Digitação manual: cerca de 5 minutos por nota, aproximadamente 600 notas por mês',
    t1i2: 'A verificação de duplicidade falha quando o número é digitado diferente; dois pagamentos duplicados no ano passado',
    t1i3: 'A mesma pessoa cadastra fornecedores e lança notas (apontado pela auditoria)',
    g1: 'Nota tem número do pedido?',
    yes: 'Sim',
    no: 'Não',
    t2: 'Pedir número do pedido ao solicitante',
    t2b: 'Informar número do pedido',
    t2bi: 'Cerca de uma em cada cinco notas chega sem pedido; a resposta pode levar dias',
    t3: 'Conferir nota, pedido e recebimento',
    t3d: 'Conferência tripla entre nota fiscal, pedido de compra e recebimento no ERP.',
    g2: 'Documentos conferem?',
    t4: 'Devolver nota ao fornecedor',
    e1: 'Nota devolvida',
    t5: 'Aprovar nota',
    t5d: 'O gestor responde "aprovado" por e-mail; o e-mail é salvo em uma pasta.',
    t5i1: 'Três dias em média; mais de uma semana quando o gestor está viajando',
    t5i2: 'Aprovações por telefone ou no corredor não deixam registro',
    t5i3: 'Multas por atraso foram pagas duas vezes no último trimestre',
    g3: 'Valor acima de 10.000?',
    t6: 'Aprovar nota',
    t7: 'Programar pagamento',
    w1: 'Terça ou quinta',
    t8: 'Gerar arquivo de pagamento',
    t9: 'Enviar arquivo ao portal do banco',
    t10: 'Autorizar pagamento no portal',
    t10d: 'Uma segunda pessoa da tesouraria autoriza o pagamento; o banco exige duas pessoas.',
    w2: 'Dia seguinte',
    t11: 'Conciliar extrato bancário',
    t11i: 'Conciliação manual em planilha, cerca de duas horas a cada vez',
    t12: 'Marcar nota como paga',
    t13: 'Enviar comprovante de pagamento',
    e2: 'Nota paga',
    invoice: 'Nota fiscal',
    corrected: 'Pedido de nota corrigida',
    payfile: 'Arquivo de pagamento',
    statement: 'Extrato bancário',
    remittance: 'Comprovante de pagamento',
    po: 'Pedido de compra',
    receipt: 'Recebimento',
    email: 'E-mail',
    sheet: 'Planilha',
    portal: 'Portal do banco',
    d5: '5 minutos por nota',
    days: 'dias',
    d3: '3 dias em média',
    d2h: 'cerca de 2 horas',
    a1: 'Não foi discutido o que acontece quando um aprovador rejeita a nota; nenhum caminho de rejeição foi modelado.',
    a2: 'Presume-se que o limite de 10.000 se aplica ao valor total da nota.',
    q1: 'O que acontece quando o gestor do centro de custo ou o diretor financeiro rejeita uma nota?',
    q2: 'Quem aprova na ausência do gestor do centro de custo?',
    q3: 'Como são tratados pagamentos urgentes fora das rodadas de terça e quinta?',
  },
  es: {
    name: 'Pago de facturas de proveedores',
    summary:
      'La factura del proveedor llega por correo y se teclea en el ERP. Cuentas por pagar la coteja con la orden de compra y la recepción, obtiene la aprobación según el importe y programa el pago. Tesorería paga dos veces por semana a través del portal del banco, concilia el extracto y confirma el pago al proveedor.',
    pool: 'Departamento financiero',
    ap: 'Cuentas por pagar',
    req: 'Solicitante',
    mgr: 'Responsable del centro de coste',
    cfo: 'Director financiero',
    tre: 'Tesorería',
    supplier: 'Proveedor',
    bank: 'Banco',
    s1: 'Factura recibida',
    t1: 'Registrar factura en el ERP',
    t1d: 'Los datos de la factura (proveedor, importe, vencimiento, número de pedido) se teclean a mano en el ERP.',
    t1i1: 'Captura manual: unos 5 minutos por factura, unas 600 facturas al mes',
    t1i2: 'El control de duplicados falla si el número se teclea distinto; dos pagos duplicados el año pasado',
    t1i3: 'La misma persona da de alta proveedores y registra facturas (señalado por auditoría)',
    g1: '¿La factura trae número de pedido?',
    yes: 'Sí',
    no: 'No',
    t2: 'Pedir número de pedido al solicitante',
    t2b: 'Indicar número de pedido',
    t2bi: 'Una de cada cinco facturas llega sin pedido; la respuesta puede tardar días',
    t3: 'Cotejar factura, pedido y recepción',
    t3d: 'Cotejo a tres bandas de factura, orden de compra y recepción en el ERP.',
    g2: '¿Los documentos coinciden?',
    t4: 'Devolver factura al proveedor',
    e1: 'Factura devuelta',
    t5: 'Aprobar factura',
    t5d: 'El responsable contesta "aprobado" por correo; el correo se guarda en una carpeta.',
    t5i1: 'Tres días de media; más de una semana si el responsable está de viaje',
    t5i2: 'Las aprobaciones por teléfono o en el pasillo no dejan registro',
    t5i3: 'Se pagaron recargos por demora dos veces el trimestre pasado',
    g3: '¿Importe superior a 10.000?',
    t6: 'Aprobar factura',
    t7: 'Programar pago',
    w1: 'Martes o jueves',
    t8: 'Generar fichero de pagos',
    t9: 'Subir fichero al portal del banco',
    t10: 'Autorizar pago en el portal',
    t10d: 'Una segunda persona de tesorería autoriza el pago; el banco exige dos personas.',
    w2: 'Día siguiente',
    t11: 'Conciliar extracto bancario',
    t11i: 'Conciliación manual en hoja de cálculo, unas dos horas cada vez',
    t12: 'Marcar factura como pagada',
    t13: 'Enviar aviso de pago',
    e2: 'Factura pagada',
    invoice: 'Factura',
    corrected: 'Solicitud de factura corregida',
    payfile: 'Fichero de pagos',
    statement: 'Extracto bancario',
    remittance: 'Aviso de pago',
    po: 'Orden de compra',
    receipt: 'Recepción',
    email: 'Correo electrónico',
    sheet: 'Hoja de cálculo',
    portal: 'Portal del banco',
    d5: '5 minutos por factura',
    days: 'días',
    d3: '3 días de media',
    d2h: 'unas 2 horas',
    a1: 'No se habló de qué ocurre cuando un aprobador rechaza la factura; no se ha modelado ninguna vía de rechazo.',
    a2: 'Se supone que el umbral de 10.000 se aplica al importe total de la factura.',
    q1: '¿Qué ocurre cuando el responsable del centro de coste o el director financiero rechaza una factura?',
    q2: '¿Quién aprueba en ausencia del responsable del centro de coste?',
    q3: '¿Cómo se gestionan los pagos urgentes fuera de las remesas de martes y jueves?',
  },
};

function build(lang: Lang): unknown {
  const t = TEXT[lang];
  return {
    name: t.name,
    summary: t.summary,
    language: lang,
    pool: t.pool,
    lanes: [
      { id: 'ap', name: t.ap },
      { id: 'req', name: t.req },
      { id: 'mgr', name: t.mgr },
      { id: 'cfo', name: t.cfo },
      { id: 'tre', name: t.tre },
    ],
    nodes: [
      { id: 's1', type: 'startEvent', eventKind: 'message', name: t.s1, lane: 'ap' },
      {
        id: 't1',
        type: 'userTask',
        name: t.t1,
        lane: 'ap',
        description: t.t1d,
        systems: ['ERP', t.email],
        inputs: [t.invoice],
        duration: t.d5,
        issues: [t.t1i1, t.t1i2, t.t1i3],
      },
      { id: 'g1', type: 'exclusiveGateway', name: t.g1, lane: 'ap' },
      { id: 't2', type: 'sendTask', name: t.t2, lane: 'ap', systems: [t.email] },
      { id: 't2b', type: 'userTask', name: t.t2b, lane: 'req', systems: [t.email], duration: t.days, issues: [t.t2bi] },
      { id: 'g1m', type: 'exclusiveGateway', name: '', lane: 'ap' },
      { id: 't3', type: 'userTask', name: t.t3, lane: 'ap', description: t.t3d, systems: ['ERP'], inputs: [t.invoice, t.po, t.receipt] },
      { id: 'g2', type: 'exclusiveGateway', name: t.g2, lane: 'ap' },
      { id: 't4', type: 'sendTask', name: t.t4, lane: 'ap', systems: [t.email] },
      { id: 'e1', type: 'endEvent', name: t.e1, lane: 'ap' },
      {
        id: 't5',
        type: 'userTask',
        name: t.t5,
        lane: 'mgr',
        description: t.t5d,
        systems: [t.email],
        duration: t.d3,
        issues: [t.t5i1, t.t5i2, t.t5i3],
      },
      { id: 'g3', type: 'exclusiveGateway', name: t.g3, lane: 'mgr' },
      { id: 't6', type: 'userTask', name: t.t6, lane: 'cfo', systems: [t.email] },
      { id: 'g3m', type: 'exclusiveGateway', name: '', lane: 'ap' },
      { id: 't7', type: 'userTask', name: t.t7, lane: 'ap', systems: ['ERP'] },
      { id: 'w1', type: 'intermediateCatchEvent', eventKind: 'timer', name: t.w1, lane: 'tre' },
      { id: 't8', type: 'userTask', name: t.t8, lane: 'tre', systems: ['ERP'], outputs: [t.payfile] },
      { id: 't9', type: 'sendTask', name: t.t9, lane: 'tre', systems: [t.portal], inputs: [t.payfile] },
      { id: 't10', type: 'userTask', name: t.t10, lane: 'tre', description: t.t10d, systems: [t.portal] },
      { id: 'w2', type: 'intermediateCatchEvent', eventKind: 'timer', name: t.w2, lane: 'tre' },
      { id: 't11', type: 'userTask', name: t.t11, lane: 'tre', systems: [t.sheet, t.portal], inputs: [t.statement], duration: t.d2h, issues: [t.t11i] },
      { id: 't12', type: 'userTask', name: t.t12, lane: 'tre', systems: ['ERP'] },
      { id: 't13', type: 'sendTask', name: t.t13, lane: 'tre', systems: [t.email], outputs: [t.remittance] },
      { id: 'e2', type: 'endEvent', name: t.e2, lane: 'tre' },
    ],
    flows: [
      { from: 's1', to: 't1' },
      { from: 't1', to: 'g1' },
      { from: 'g1', to: 'g1m', label: t.yes },
      { from: 'g1', to: 't2', label: t.no },
      { from: 't2', to: 't2b' },
      { from: 't2b', to: 'g1m' },
      { from: 'g1m', to: 't3' },
      { from: 't3', to: 'g2' },
      { from: 'g2', to: 't5', label: t.yes },
      { from: 'g2', to: 't4', label: t.no },
      { from: 't4', to: 'e1' },
      { from: 't5', to: 'g3' },
      { from: 'g3', to: 't6', label: t.yes },
      { from: 'g3', to: 'g3m', label: t.no },
      { from: 't6', to: 'g3m' },
      { from: 'g3m', to: 't7' },
      { from: 't7', to: 'w1' },
      { from: 'w1', to: 't8' },
      { from: 't8', to: 't9' },
      { from: 't9', to: 't10' },
      { from: 't10', to: 'w2' },
      { from: 'w2', to: 't11' },
      { from: 't11', to: 't12' },
      { from: 't12', to: 't13' },
      { from: 't13', to: 'e2' },
    ],
    externals: [
      { id: 'supplier', name: t.supplier },
      { id: 'bank', name: t.bank },
    ],
    messageFlows: [
      { from: 'supplier', to: 's1', label: t.invoice },
      { from: 't4', to: 'supplier', label: t.corrected },
      { from: 't9', to: 'bank', label: t.payfile },
      { from: 'bank', to: 't11', label: t.statement },
      { from: 't13', to: 'supplier', label: t.remittance },
    ],
    assumptions: [t.a1, t.a2],
    openQuestions: [t.q1, t.q2, t.q3],
  };
}

const asLang = (language: string): Lang => (language === 'pt-BR' || language === 'es' ? language : 'en');

export function sampleTranscript(language: string): SourceDocument {
  const sample = TRANSCRIPTS[asLang(language)];
  return { name: sample.name, kind: 'transcript', format: 'WebVTT', text: sample.text };
}

export function sampleModel(language: string): ProcessModel {
  return normalizeModel(build(asLang(language))).model;
}
