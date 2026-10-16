// Text the server sends in English, translated by tx in ../../i18n.js.
// Exact sentences are plain keys; sentences with values in them are templates
// with {placeholders}. Where the sentence came from is noted per group.

// Ages come from fmtAge() (domain/attention.js) and ago() (domain/production.js):
// "45m", "3h" or "5d". Each key below with {age} is also added once per unit,
// so "Open 5d (stale)" reads "Aberto há 5 d (parado)"; the plain {age} key is
// the fallback.
const AGE_UNITS = [['m', ' min'], ['h', ' h'], ['d', ' d']];
function ages(entries) {
  const out = {};
  for (const [en, pt] of Object.entries(entries)) {
    out[en] = pt;
    for (const [unit, ptUnit] of AGE_UNITS) out[en.replace('{age}', `{n}${unit}`)] = pt.replace('{age}', `{n}${ptUnit}`);
  }
  return out;
}

export default {
  // ---------------------------------------------------------------- Inbox (domain/attention.js)
  ...ages({
    'Waiting on you for {age}': 'À espera de si há {age}',
    'Waiting on you for {age}: "{instructions}"': 'À espera de si há {age}: "{instructions}"',
    'Waiting on your team for {age}': 'À espera da sua equipa há {age}',
    'Waiting on your team for {age}: "{instructions}"': 'À espera da sua equipa há {age}: "{instructions}"',
    'Last deployment to {stage} failed or was rejected {age} ago': 'O último deploy para {stage} falhou ou foi rejeitado há {age}',
    'Waiting on your review for {age}': 'À espera da sua revisão há {age}',
    'No approvals after {age}': 'Sem aprovações após {age}',
    'Open {age} (stale)': 'Aberto há {age} (parado)',
    'Draft open {age}': 'Rascunho aberto há {age}',
    'Last green {age} ago': 'Última execução com êxito há {age}',
  }),
  'No reviewers assigned': 'Sem revisores atribuídos',
  'Rejected by {names}': 'Rejeitado por {names}',
  'Approved but not merged — set auto-complete or nudge author': 'Aprovado mas sem merge — ative a conclusão automática ou lembre o autor',
  'Merge conflicts': 'Conflitos de merge',
  'Reviewers are waiting on you (your PR)': 'Os revisores estão à sua espera (o seu PR)',
  Blocked: 'Bloqueado',
  'P1 bug with no owner': 'Bug P1 sem responsável',
  'P1 bug not started': 'Bug P1 por iniciar',
  'In "{state}" with no updates for {days}d': 'Em "{state}" sem atualizações há {days} d',
  'In current sprint but unassigned': 'No sprint atual, mas sem responsável',
  'No green run in the lookback window': 'Nenhuma execução com êxito no período analisado',
  '{pct}% pass rate over {n} runs': '{pct}% de sucesso em {n} execuções',

  // Inbox titles
  '{name} is down': '{name} está em baixo',
  '{name} is degraded': '{name} está degradado',
  'Approve {pipeline}': 'Aprovar {pipeline}',
  // Fallback name for a YAML approval whose run wasn't found (azdo/provider.js).
  'Pipeline run': 'Execução do pipeline',
  '{name}: {stage} deployment failed': '{name}: o deploy para {stage} falhou',
  '{name} is failing on {branch}': '{name} está a falhar em {branch}',
  '{name} is unstable': '{name} está instável',
  '{name} may be overloaded': '{name} pode ter trabalho a mais',

  // Inbox context lines
  '{context} · pipeline check': '{context} · verificação do pipeline',
  '{context} · release approval': '{context} · aprovação de release',
  '{context} · {n} consecutive failures': '{context} · {n} falhas consecutivas',
  '{context} · {n} consecutive failure': '{context} · {n} falha consecutiva',
  '{context} · Unassigned': '{context} · Sem responsável',
  'Team load': 'Carga da equipa',

  // Team load flags (domain/workload.js)
  '{n} items in progress': '{n} itens em curso',
  '{n} reviews pending': '{n} revisões pendentes',
  'No assigned work': 'Sem trabalho atribuído',

  // Health words the server writes (pipelines, releases, monitors)
  failing: 'a falhar',
  unstable: 'instável',
  healthy: 'saudável',
  down: 'em baixo',
  degraded: 'degradado',
  up: 'em funcionamento',
  unknown: 'desconhecido',

  // ---------------------------------------------------------------- Production (domain/production.js, monitoring.js)
  ...ages({
    'Down for {age}: {error}': 'Em baixo há {age}: {error}',
    'Failures up from {before} to {after} since {deploy} ({age} ago)': 'As falhas subiram de {before} para {after} desde {deploy} (há {age})',
  }),
  'Last check failed: {error}': 'A última verificação falhou: {error}',
  'Slow: {seconds}s (limit {limit}s)': 'Lento: {seconds} s (limite {limit} s)',
  '{pct} of requests failing in the last hour ({failed} of {total})': '{pct} dos pedidos a falhar na última hora ({failed} de {total})',
  'no response': 'sem resposta',
  'No response within 10s': 'Sem resposta em 10 s',
  'fetch failed': 'o pedido falhou',
  'Application Insights refused the API key ({detail})': 'O Application Insights recusou a chave de API ({detail})',
  'Enter the API key to test Application Insights': 'Introduza a chave de API para testar o Application Insights',
  'Enter a full URL, like https://myapp.example.com/health': 'Introduza um URL completo, como https://myapp.example.com/health',
  'Only http and https URLs can be monitored': 'Só é possível monitorizar URLs http e https',
  "Don't put credentials in the URL": 'Não coloque credenciais no URL',
  "Couldn't resolve {host}": 'Não foi possível resolver {host}',
  '{host} is a private or internal address. Set MONITOR_ALLOW_PRIVATE=1 on the server to allow it.': '{host} é um endereço privado ou interno. Defina MONITOR_ALLOW_PRIVATE=1 no servidor para o permitir.',
  'Send a list of up to 50 monitors': 'Envie uma lista com 50 monitores no máximo',
  'Every monitor needs a name': 'Todos os monitores precisam de um nome',
  '"{name}" needs a URL or an Application Insights App ID': '"{name}" precisa de um URL ou de um App ID do Application Insights',
  '"{name}": the Application ID is a GUID like 0f1e2d3c-…, from the Application Insights "API Access" page': '"{name}": o Application ID é um GUID como 0f1e2d3c-…, da página "API Access" do Application Insights',
  'Production monitoring is not available on this server': 'A monitorização de produção não está disponível neste servidor',

  // ---------------------------------------------------------------- Notifications (domain/changes.js)
  '{name} approved your pull request': '{name} aprovou o seu pull request',
  '{name} approved your pull request with suggestions': '{name} aprovou o seu pull request com sugestões',
  '{name} is waiting for changes on your pull request': '{name} está à espera de alterações no seu pull request',
  '{name} rejected your pull request': '{name} rejeitou o seu pull request',
  '{name} voted on your pull request': '{name} votou no seu pull request',
  'Your pull request is no longer active': 'O seu pull request já não está ativo',
  '{title} was completed or abandoned': '{title} foi concluído ou abandonado',
  'Your run of {pipeline} succeeded': 'A sua execução de {pipeline} foi concluída com êxito',
  'Your run of {pipeline} partially succeeded': 'A sua execução de {pipeline} foi parcialmente concluída',
  'Your run of {pipeline} failed': 'A sua execução de {pipeline} falhou',
  'Your run of {pipeline} was canceled': 'A sua execução de {pipeline} foi cancelada',
  'Your run of {pipeline} finished': 'A sua execução de {pipeline} terminou',
  '{build} on refs/{ref}': '{build} em refs/{ref}',

  // ---------------------------------------------------------------- Insights (domain/insights.js)
  '< 1 day': '< 1 dia',
  '1–3 days': '1–3 dias',
  '3–7 days': '3–7 dias',
  '1–2 weeks': '1–2 semanas',
  '> 2 weeks': '> 2 semanas',

  // Demo-mode reason (config.js)
  requested: 'a pedido',
  'AZDO_ORG_URL not set': 'AZDO_ORG_URL não definido',
  'AZDO_PAT not set': 'AZDO_PAT não definido',

  // ---------------------------------------------------------------- API errors (routes.js, security.js)
  'Missing x-keel header': 'Falta o cabeçalho x-keel',
  'Your role in Keel does not allow this.': 'O seu perfil no Keel não permite esta ação.',
  'Invalid id': 'ID inválido',
  'key required': 'Falta a chave',
  'Unknown approval kind': 'Tipo de aprovação desconhecido',
  'No API route {method} {path}': 'Não existe a rota de API {method} {path}',
  'Unexpected error': 'Erro inesperado',
  'Cross-origin request blocked': 'Pedido de outra origem bloqueado',

  // Pull requests, work items, releases (service.js)
  "That repository isn't one of your tracked repos": 'Esse repositório não é um dos que acompanha',
  'Pick a source and a target branch': 'Escolha uma branch de origem e uma de destino',
  'Source and target branches must be different': 'As branches de origem e de destino têm de ser diferentes',
  'Give the pull request a title': 'Dê um título ao pull request',
  'Title is too long (400 characters max)': 'O título é demasiado longo (máximo de 400 caracteres)',
  'Description is too long (Azure DevOps allows 4,000 characters)': 'A descrição é demasiado longa (o Azure DevOps permite 4000 caracteres)',
  'Invalid vote': 'Voto inválido',
  'Comment is empty': 'O comentário está vazio',
  'Give a reason for overriding branch policies': 'Indique o motivo para ignorar as políticas da branch',
  'Unknown action {action}': 'Ação desconhecida: {action}',
  'Status must be approved or rejected': 'O estado tem de ser aprovado ou rejeitado',
  'That approval is no longer pending. It may have been handled already.': 'Essa aprovação já não está pendente. Pode já ter sido tratada.',
  'Unknown project': 'Projeto desconhecido',
  'Invalid date range': 'Intervalo de datas inválido',
  'Preferences are too large': 'As preferências são demasiado grandes',

  // Sign-in and accounts (auth.js, accounts.js)
  'Too many attempts. Try again in {n} minute.': 'Demasiadas tentativas. Tente novamente dentro de {n} minuto.',
  'Too many attempts. Try again in {n} minutes.': 'Demasiadas tentativas. Tente novamente dentro de {n} minutos.',
  'Keel is already set up. Sign in instead.': 'O Keel já está configurado. Entre com a sua conta.',
  'Keel is already set up.': 'O Keel já está configurado.',
  'That setup code is wrong. It is printed in the server log when Keel starts.': 'O código de configuração está errado. É apresentado no registo do servidor quando o Keel arranca.',
  'Sign in to continue.': 'Entre para continuar.',
  "That doesn't look like a personal access token. Paste the token itself (letters and numbers only).": 'Isso não parece um personal access token. Cole o próprio token (só letras e números).',
  "Azure DevOps didn't accept that token for {org}. Check it hasn't expired and that it was created for this organization.": 'O Azure DevOps não aceitou esse token para {org}. Confirme que não expirou e que foi criado para esta organização.',
  "Couldn't reach Azure DevOps to check the token: {error}": 'Não foi possível contactar o Azure DevOps para verificar o token: {error}',
  'Only admins can manage users.': 'Só os administradores podem gerir utilizadores.',
  'Connect your Azure DevOps account to continue.': 'Ligue a sua conta do Azure DevOps para continuar.',
  'Connect your Azure DevOps account again.': 'Ligue novamente a sua conta do Azure DevOps.',
  'Use a password of at least 10 characters.': 'Use uma palavra-passe com pelo menos 10 caracteres.',
  'That password is too long.': 'Essa palavra-passe é demasiado longa.',
  'This link is invalid or has expired. Ask your admin for a new one.': 'Este link é inválido ou expirou. Peça um novo ao seu administrador.',
  'Enter a valid email address.': 'Introduza um endereço de email válido.',
  'Email or password is incorrect.': 'O email ou a palavra-passe estão incorretos.',
  'This account has been disabled. Ask your admin.': 'Esta conta foi desativada. Fale com o seu administrador.',
  'Pick a role: Admin, Developer or PM.': 'Escolha um perfil: Admin, Developer ou PM.',
  '{email} already has an account.': '{email} já tem uma conta.',
  'No such user.': 'Esse utilizador não existe.',
  'Your current password is incorrect.': 'A sua palavra-passe atual está incorreta.',
  'Keel needs at least one active admin.': 'O Keel precisa de pelo menos um administrador ativo.',
  "You can't disable your own account.": 'Não pode desativar a sua própria conta.',
  'Unknown role.': 'Perfil desconhecido.',
  "You can't remove your own account.": 'Não pode remover a sua própria conta.',

  // ---------------------------------------------------------------- Azure DevOps (azdo/client.js, azdo/provider.js)
  'Network error calling Azure DevOps: {error}': 'Erro de rede ao contactar o Azure DevOps: {error}',
  'Azure DevOps rejected the token: it may have expired, been revoked, or lack the needed scopes.': 'O Azure DevOps recusou o token: pode ter expirado, sido revogado ou não ter as permissões necessárias.',
  'Azure DevOps {method} {path} failed ({status}): {detail}': 'O pedido {method} {path} ao Azure DevOps falhou ({status}): {detail}',
  'Invalid image URL': 'URL de imagem inválido',
  'Only images from your Azure DevOps organization can be loaded': 'Só é possível carregar imagens da sua organização do Azure DevOps',
  'Refusing non-HTTPS image redirect': 'Redirecionamento de imagem sem HTTPS recusado',
  'Image request failed ({status})': 'O pedido da imagem falhou ({status})',
  'Not an image': 'Não é uma imagem',
  'Image too large': 'Imagem demasiado grande',
  "Azure DevOps hasn't finished preparing the merge yet. Try again in a moment.": 'O Azure DevOps ainda não terminou de preparar o merge. Tente novamente daqui a pouco.',

  // Demo mode (mock/provider.js)
  'Pull request {id} not found': 'Pull request {id} não encontrado',
  'Work item {id} not found': 'Work item {id} não encontrado',
  'Approval not found': 'Aprovação não encontrada',
  'Release pipeline not found': 'Pipeline de release não encontrado',
  'Release stage not found': 'Stage de release não encontrado',
  'Repository not found': 'Repositório não encontrado',
  'Reviewer not found': 'Revisor não encontrado',
  'No images in demo mode': 'Não há imagens no modo de demonstração',
  'The pull request has merge conflicts. Resolve them before completing.': 'O pull request tem conflitos de merge. Resolva-os antes de o concluir.',
  'TF401027: The policy "Minimum number of reviewers ({n})" is not satisfied. Get approvals, or override policies if you have permission.': 'TF401027: A política "Número mínimo de revisores ({n})" não está cumprida. Obtenha aprovações ou ignore as políticas se tiver permissão.',
  "State '{state}' is not valid for {type}": "O estado '{state}' não é válido para {type}",
// Platform health and totals (server/platform.js, server/monitoring.js, domain/production.js)
  'Degraded: {reason}': 'Degradado: {reason}',
  'Platform totals: {error}': 'Totais da plataforma: {error}',
  'a check failed': 'uma verificação falhou',
  'The database did not answer in time.': 'A base de dados não respondeu a tempo.',
  'This figure could not be read from the audit log.': 'Não foi possível ler este número do registo de auditoria.',
  'The site answered 404 to /totals: check the totals key, or that the site has one configured.': 'O site respondeu 404 a /totals: verifique a chave de totais, ou se o site tem uma configurada.',
  'The site did not answer with platform totals (HTTP {status}).': 'O site não respondeu com os totais da plataforma (HTTP {status}).',
  'The site answered a "{kind}" response instead of totals.': 'O site respondeu com "{kind}" em vez dos totais.',
  'The site could not calculate the totals (HTTP {status}).': 'O site não conseguiu calcular os totais (HTTP {status}).',
  'The totals took longer than 5 minutes; the site may be busy.': 'Os totais demoraram mais de 5 minutos; o site pode estar ocupado.',
  'The site redirected /totals (HTTP {status}); use the address it redirects to.': 'O site redirecionou /totals (HTTP {status}); use o endereço para onde redireciona.',
  '"{name}": platform totals need the site\'s URL': '"{name}": os totais da plataforma precisam do URL do site',
  "Add the site's totals key first.": 'Adicione primeiro a chave de totais do site.',
  'The totals are already being fetched.': 'Os totais já estão a ser obtidos.',
  'The totals were fetched less than 10 minutes ago. Each fetch keeps the club database busy, so wait a little.': 'Os totais foram obtidos há menos de 10 minutos. Cada pedido ocupa a base de dados do clube, por isso aguarde um pouco.',
  'No such monitor.': 'Esse monitor não existe.',
  // Creating work items (service.js)
  'Pick one of your tracked projects.': 'Escolha um dos projetos que acompanha.',
  'Pick a work item type.': 'Escolha um tipo de work item.',
  'Give the work item a title.': 'Dê um título ao work item.',
  'The title can have at most 255 characters.': 'O título pode ter no máximo 255 caracteres.',
  'Work item {id} does not exist.': 'O work item {id} não existe.',
};
