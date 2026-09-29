# Segurança do Firebase no CheckLog

O arquivo **checklog/database.rules.json** é a fonte de verdade das regras do
Realtime Database usadas pelo CheckLog. As regras partem de negação total e
abrem somente os caminhos necessários para cada perfil.

## Primeiro administrador

O navegador não pode promover uma conta a administrador. O primeiro acesso
administrativo deve ser provisionado por alguém que já controla o projeto no
Firebase:

1. Crie ou localize o usuário em **Authentication > Users**.
2. Copie o UID desse usuário.
3. No **Realtime Database**, crie **cargos/<UID>** com:

       {
         "cargo": "Administrador",
         "setor": "Administrativo"
       }

4. Se a conta também representar um funcionário, mantenha o cadastro completo
   em **funcionarios/<matricula>** e use o mesmo UID.
5. Entre novamente no CheckLog e confirme que o menu administrativo aparece.

O Console do Firebase e o Admin SDK ignoram as regras do cliente, por isso só
devem ser usados por responsáveis autorizados. Nunca coloque uma chave de conta
de serviço, arquivo **firebase-adminsdk*.json** ou credencial privada no
repositório.

Depois do primeiro provisionamento, administradores existentes continuam
criando os cadastros autorizados pela aplicação. Se o último administrador
perder o acesso, a recuperação também precisa ser feita pelo Console ou pelo
Admin SDK.

## Proteções aplicadas

- **avisos** só pode ser lido por uma conta autenticada que possua um cargo
  cadastrado. Uma conta criada apenas no Authentication não recebe dados.
- **historico_ponto** e **historico_estoque** aceitam somente novos eventos. As
  regras do cliente impedem editar ou excluir registros de auditoria existentes.
- **controles_ponto** cria um bloqueio curto por funcionário e jornada. O token,
  o movimento e a chave ficam vinculados ao novo registro pelas regras, evitando
  que uma aba atrasada grave depois que outro controle assumir a jornada.
- **movimentacoes_estoque** também é append-only, e novos eventos vinculam UID
  e e-mail ao usuário autenticado. Uma reconciliação pendente só pode repetir o
  registro exato preservado no próprio produto.
- Produtos exigem nome e categoria textuais com limites, além de quantidades
  inteiras e valores não negativos.
- Uma justificativa nova precisa repetir UID, nome, e-mail, setor, cargo e turno
  do funcionário cadastrado. Quando informa um ponto de origem, esse registro
  também precisa pertencer ao mesmo funcionário.
- Datas, horários, motivo, movimento e status obrigatórios são validados antes
  da gravação.

Essas garantias valem para clientes sujeitos às regras do Realtime Database.
Responsáveis com acesso administrativo ao projeto Firebase continuam capazes
de alterar os dados diretamente.

## Publicação

Execute o comando dentro da pasta **checklog**, onde o **firebase.json**
referencia o arquivo local de regras:

    cd "C:\Users\Aluno\Desktop\oficial\checklog"
    firebase deploy --only database --project checklog-database

Antes de confirmar a publicação, confira no terminal se o alvo exibido é o
projeto **checklog-database**. O deploy das regras é uma etapa operacional
separada do commit do código.

## Cache e desempenho

Os módulos locais usam um identificador de versão único. Assim, uma publicação
nova invalida o JavaScript antigo sem desativar o cache normal do navegador.

Dados operacionais de ponto e estoque não recebem cache persistente no cliente.
Eles continuam vindo do Realtime Database para evitar decisões baseadas em
saldo, jornada ou aprovação desatualizados. As listas em memória servem apenas
à sessão e à tela atual.

Se o volume crescer, o próximo passo seguro é particionar pontos, históricos e
movimentações por empresa e período, adicionar os índices correspondentes nas
regras e consultar apenas o intervalo necessário. Guardar coleções completas em
cache local reduziria leituras, mas aumentaria o risco de divergência justamente
nos fluxos que precisam de consistência.

## Limitações conhecidas

Este projeto ainda usa autorização administrativa baseada no setor
(Administrativo, Recursos Humanos ou TI). Separar permissões por ação com
custom claims é mais seguro, mas exige um serviço confiável com Admin SDK e uma
migração dos perfis atuais.

As regras validam cada gravação, mas não coordenam sozinhas toda a sequência de
ponto, aprovações simultâneas ou o cadastro combinado entre Authentication e
Realtime Database. Garantias fortes de unicidade e concorrência exigem uma
operação transacional em backend, como Cloud Functions ou outro serviço
controlado. Até essa migração, as transações e chaves determinísticas do cliente
reduzem conflitos, mas não substituem essa autoridade central.

As regras também não funcionam como limitador de requisições. App Check ajuda a
barrar clientes não autorizados, mas limites por usuário e proteção contra abuso
de uma conta válida exigem monitoramento e controle no backend.
