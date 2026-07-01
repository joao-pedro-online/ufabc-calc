# Boletim UFABC

Calculadora de CR, CA e CP que lê o **Histórico Escolar em PDF** (exportado do SIGAA) e
já lança todas as matérias automaticamente — sem digitação manual. Tudo roda no navegador,
nada é enviado a nenhum servidor.

## Como usar

1. Abra o site (veja "Deploy" abaixo, ou simplesmente abra `index.html` localmente).
2. Solte o PDF do seu Histórico Escolar (SIGAA → Central de Atendimento ao Estudante →
   Documentos → Histórico Escolar).
3. O CR e o CA aparecem imediatamente — calculados 100% a partir das suas notas, sem
   depender de nenhuma grade curricular.
4. Para o CP, informe os créditos totais exigidos para integralização do seu curso (some
   Obrigatórias + Opção Limitada + Livres + Complementares do rodapé do seu histórico, em
   créditos = CH ÷ 12). O CP mostrado é uma aproximação.
5. Edite o conceito de qualquer matéria com situação `MATR` (matriculado, sem nota ainda)
   para simular "e se eu tirar B nessa matéria?" — os coeficientes recalculam na hora.
6. Use "+ simular matéria futura" para adicionar qualquer disciplina da UFABC (buscando por
   nome/código) e projetar o impacto dela no seu CR/CA antes mesmo de se matricular.

## Como funciona (a lógica por trás)

- **Extração do PDF**: o histórico do SIGAA é uma tabela com células multi-linha (código,
  turma e docente quebram em várias linhas, sempre centralizadas verticalmente dentro do
  "bloco" da linha). O `app.js` usa o `pdf.js` para ler a posição (x,y) de cada fragmento de
  texto, agrupa por linha, e distribui cada linha para a matéria certa usando o ponto médio
  entre os períodos (`2022.3`, `2023.1`, ...) como âncora de cada linha da tabela. Esse
  algoritmo foi validado contra o histórico real: reproduz **exatamente** os valores de CR e
  CA impressos pelo próprio SIGAA.
- **CR (Coeficiente de Rendimento)**: média ponderada de todos os conceitos × créditos de
  todas as disciplinas cursadas (contando reprovações), dividida pelo total de créditos
  cursados — conforme Resolução ConsEPE nº 147/273.
- **CA (Coeficiente de Aproveitamento)**: igual ao CR, mas se você refez uma matéria, só o
  melhor conceito conta.
- **CP (Coeficiente de Progressão)**: créditos aprovados ÷ créditos exigidos para
  integralização. Aqui o site pede um número manual, porque o SIGAA imprime esse total no
  histórico, mas grades curriculares mudam de versão em versão — puxar isso automaticamente
  arriscaria dar um número errado. Fica mais seguro (e mais simples) você conferir o número
  no seu próprio histórico.
- **Simulação de matérias futuras**: usa uma base com ~1440 disciplinas da UFABC e suas
  categorias (Obrigatória / Opção Limitada / Livre) por curso, extraída do catálogo oficial
  exportado do site da UFABC (`catalogo_disciplinas_graduacao_categorias_2024_2025.xlsx`).
  **Ressalva:** esse catálogo reflete o currículo vigente em 2024/2025. A UFABC reforma
  grades de tempos em tempos — quem entrou em anos anteriores pode ter 1-2 disciplinas
  classificadas diferente do currículo que efetivamente vale pro seu registro (ex:
  disciplinas que eram Obrigatórias e passaram a ser Opção Limitada, ou vice-versa). Para
  a maioria dos cursos isso afeta poucos créditos; o CR e o CA nunca são afetados por isso,
  só a categorização OBR/OL/Livre usada no CP e na simulação.

## Estrutura

```
index.html
style.css
app.js
data/
  disciplinas.json   # ~1300 disciplinas da UFABC com créditos e categoria por curso
  cursos.json         # mapa sigla → nome do curso
```

## Deploy no GitHub Pages

1. Crie um repositório novo (pode ser público ou privado) e suba estes arquivos na raiz.
2. Vá em **Settings → Pages**, em "Source" escolha a branch `main` e a pasta `/ (root)`.
3. Em ~1 minuto o site fica em `https://<seu-usuario>.github.io/<repo>/`.

Não precisa de build, backend, nem chave de API — é só HTML/CSS/JS estático.

## Limitações conhecidas

- O parser foi validado no formato de histórico atual do SIGAA (2026). Se a UFABC mudar o
  layout do PDF, os limites de coluna em `app.js` (`COLS`) podem precisar de ajuste.
- Disciplinas convalidadas/incorporadas por mobilidade ou equivalência aparecem no PDF sem
  conceito — elas não entram no CR/CA (correto), mas talvez precisem entrar manualmente no
  cálculo do CP se contarem como aprovadas.
- O CP é aproximado por design (veja acima).
