# CheckLog e Power BI

O CheckLog gera arquivos CSV locais para análise no Power BI Desktop. A exportação não envia dados para a Microsoft e não exige conta online.

## Primeiros passos

1. Instale o Power BI Desktop pela Microsoft Store ou pelo site oficial da Microsoft.
2. Entre no CheckLog como administrador.
3. Abra **Relatórios**.
4. No painel **Exportar para Power BI**, escolha o conjunto, período e privacidade.
5. Mantenha **Anonimizado** para demonstrações.
6. Clique em **Gerar CSV**.
7. No Power BI Desktop, use **Obter dados > Texto/CSV** e selecione o arquivo.
8. Confirme vírgula como delimitador e UTF-8 como origem do arquivo.

## Conjuntos

- **Resumo diário de ponto:** horas trabalhadas, jornada esperada, saldo e situação diária.
- **Posição atual do estoque:** quantidades, limites, custos e margens.
- **Movimentações de estoque:** entradas, retiradas e evolução do saldo.

## Tipos recomendados

- Datas: `data` e `data_hora`.
- Número inteiro: quantidades e minutos.
- Número decimal: custos, preços, valores e margens.
- Verdadeiro/falso: `jornada_encerrada`.
- Texto: identificadores, nomes, categorias, tipos e observações.

## Visuais sugeridos

- Colunas: minutos trabalhados por dia.
- Cartão: saldo total de minutos.
- Linha: evolução das movimentações.
- Barras: quantidade atual por categoria.
- Tabela: produtos com `situacao_estoque` igual a `critico`.

## Medidas iniciais

```DAX
Saldo total (horas) =
DIVIDE(SUM('ponto'[saldo_minutos]), 60)
```

```DAX
Itens críticos =
CALCULATE(
    COUNTROWS('estoque'),
    'estoque'[situacao_estoque] = "critico"
)
```

## Privacidade

Use arquivos pseudonimizados em apresentações. Os códigos estáveis ainda podem permitir correlação entre linhas, portanto não são anonimização irreversível. Arquivos identificados podem conter nomes e matrículas e devem permanecer em local controlado. Não publique dados de funcionários usando **Publicar na Web**.

## Dados fictícios

Os arquivos em `checklog/powerbi/samples/` permitem experimentar a importação sem acessar dados reais.
