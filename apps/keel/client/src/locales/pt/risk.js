// A pull request's risk (server/domain/risk.js): its reasons, translated with t(text, params), and
// where the list and the details panel show it.
export default {
  '{n} lines changed in {files} files': '{n} linhas alteradas em {files} ficheiros',
  '{files} files changed (line counts not known)': '{files} ficheiros alterados (sem contagem de linhas)',
  'Changes {n} folders that changed often lately (commits in {days} days: {where})': 'Altera {n} pastas que mudaram muito ultimamente (commits em {days} dias: {where})',
  'Changes a folder that changed often lately (commits in {days} days: {where})': 'Altera uma pasta que mudou muito ultimamente (commits em {days} dias: {where})',
  'Needs a code owner to approve': 'Precisa da aprovação de um responsável pelo código',
  'Changes dependencies ({files})': 'Altera dependências ({files})',
  'Changes infrastructure as code ({files})': 'Altera infraestrutura como código ({files})',
  'Changes database migrations ({files})': 'Altera migrações de base de dados ({files})',
  'Changes CI or pipeline definitions ({files})': 'Altera definições de CI ou pipelines ({files})',
  'Touches auth or security code ({files})': 'Mexe em código de autenticação ou segurança ({files})',
  'Changes {n} source files and no tests': 'Altera {n} ficheiros de código e nenhum teste',
  'Needs {n} code owners to approve': 'Precisa da aprovação de {n} responsáveis pelo código',
  '{name} has no commits in these folders in the last {days} days': '{name} não tem commits nestas pastas nos últimos {days} dias',
  '{name} has no commits in {n} of these {total} folders in the last {days} days': '{name} não tem commits em {n} destas {total} pastas nos últimos {days} dias',
  'Its files could not be read, so only its reviewers count': 'Não foi possível ler os ficheiros, por isso só contam os revisores',

  Risk: 'Risco',
  'Risk {score} of 100: {level}': 'Risco {score} em 100: {level}',
  'high risk': 'risco alto',
  'medium risk': 'risco médio',
  'low risk': 'risco baixo',
  'Nothing adds to it: a small change, with tests, by someone who has worked here.': 'Nada lhe acrescenta: uma alteração pequena, com testes, de alguém que já trabalhou aqui.',
  '+{n}': '+{n}',
  'How risky this pull request is, from its size, what it touches, its tests, its code owners and its author: the reasons in its panel.': 'Quão arriscado é este pull request, pelo tamanho, pelo que altera, pelos testes, pelos responsáveis e pelo autor: as razões estão no seu painel.',
};
