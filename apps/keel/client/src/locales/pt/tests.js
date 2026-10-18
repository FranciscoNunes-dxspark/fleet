// Filled in by area; see ../pt.js.
// Area "tests": Pipelines → Flaky tests, the same list in the pipeline panel, and run times.
export default {
  'Flaky tests': 'Testes instáveis',
  'Reading test results…': 'A ler os resultados dos testes…',
  "Tests that failed and then passed again without a fix, on each pipeline's own branch over the last {days} days: re-run on the same commit and passed, or failed at least twice with passes in between. Only failed runs' test results are read.": 'Testes que falharam e voltaram a passar sem correção, no branch de cada pipeline nos últimos {days} dias: repetidos no mesmo commit e passaram, ou falharam pelo menos duas vezes com passagens pelo meio. Só são lidos os resultados das execuções que falharam.',
  '{runs} runs of {pipelines} pipelines looked at.': '{runs} execuções de {pipelines} pipelines analisadas.',
  'Times it went from failing to passing or back': 'Vezes que passou de falhar a passar ou o contrário',
  'Flips': 'Mudanças',
  '{n} flips': '{n} mudanças',
  'Last failed': 'Última falha',
  'It failed, then passed when the same commit was run again': 'Falhou e depois passou quando o mesmo commit foi executado de novo',
  'Passed on a re-run': 'Passou ao repetir',
  'Failed in the latest run': 'Falhou na última execução',
  'No test results could be read for the failed runs. Either the pipelines publish no test results, or the token lacks the Test Management (Read) scope.': 'Não foi possível ler resultados de testes das execuções que falharam. Ou os pipelines não publicam resultados de testes, ou o token não tem o âmbito Test Management (Read).',
  'No flaky tests found in this period.': 'Nenhum teste instável neste período.',
  '{n} more on Pipelines → Flaky tests.': 'Mais {n} em Pipelines → Testes instáveis.',
  // Run times (RunTimesChart in charts.jsx, PipelineDetail.jsx)
  '{name}: ran {run}, waited {wait}': '{name}: executou {run}, esperou {wait}',
  'older': 'mais antigas',
  'newest': 'mais recente',
  'Waiting for an agent': 'À espera de um agente',
  'Dashed: median {time}': 'Tracejado: mediana {time}',
  'Typical wait for an agent': 'Espera típica por um agente',
  'Run times, last {n} runs': 'Duração das últimas {n} execuções',
  'Median {recent} this week, {before} the week before': 'Mediana de {recent} esta semana, {before} na semana anterior',
};
