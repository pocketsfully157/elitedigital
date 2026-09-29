# Elite Digital — nova loja

Loja em português com uma nova identidade visual, catálogo, pesquisa e filtros, páginas de produto, favoritos, comparação, carrinho, contas de cliente, encomendas e administração. Pagamento manual por **MB WAY para 928 388 859**.

## Começar

É necessário **Node.js 24 ou superior**. A aplicação não precisa de instalar bibliotecas para funcionar.

```sh
cp .env.example .env
npm start
```

Abrir **http://127.0.0.1:3000**. Usar o mesmo endereço de `ORIGIN`, incluindo o nome do host, ao abrir a loja. Se alterares a porta, atualiza também `ORIGIN`.

### Criar a conta de administração

Definir `ADMIN_EMAIL` e `ADMIN_PASSWORD` no ambiente local e executar:

```sh
npm run admin
```

Usar uma palavra-passe única com 12 a 128 caracteres. Não guardar credenciais no GitHub. Entrar em `/#/conta` e abrir `/#/admin`. O script recusa substituir uma conta existente.

## O que funciona

- Catálogo com 118 produtos de referência e imagens locais, pesquisável sem diferenciar acentos.
- Filtros por categoria, marca, preço e stock; ordenação e paginação.
- Página de produto, comparação até três produtos e favoritos.
- Carrinho com quantidades e persistência no navegador.
- Registo, entrada, saída, sessões revogáveis e histórico privado por cliente.
- Morada de entrega em Portugal continental, portes configuráveis e NIF opcional.
- Encomendas persistidas em SQLite, preços calculados pelo servidor e reserva atómica de stock.
- Proteção contra encomendas duplicadas e quantidades superiores ao stock.
- Instruções MB WAY, indicação de transferência pelo cliente e confirmação manual pelo administrador.
- Estados de pagamento, envio e entrega; cancelamento de encomendas não pagas e reposição do stock.
- Reservas não pagas expiram em 24 horas. Encomendas com pagamento indicado aguardam revisão humana, sem expirar automaticamente.
- Administração de preços, descrições e stock; validação individual dos produtos e configuração comercial.
- Formulário de contacto guardado na base de dados e visível no painel.
- Recuperação de palavra-passe por email, quando o envio por Resend estiver configurado.

## MB WAY: processo manual

1. O cliente regista a encomenda e recebe o valor exato e o número **928 388 859**.
2. Efetua a transferência na sua própria aplicação MB WAY.
3. Carrega em **Já efetuei o pagamento**. O estado passa para **Pagamento em verificação**.
4. O administrador verifica a entrada do valor na sua aplicação e confirma-a no painel.
5. O administrador regista o envio e, depois, a entrega.

O botão do cliente **não confirma que houve entrada de dinheiro**. Não existe ligação automática à SIBS, ao banco ou a um gateway. A loja não pede credenciais bancárias nem dados de cartão. O contacto recebido na base de dados não gera automaticamente um email.

## Antes de abrir vendas

A loja inicia em **pré-lançamento**, com vendas encerradas e todos os produtos por validar. O catálogo é uma amostra obtida da página pública [elitedigital.pt](https://www.elitedigital.pt/) em 29/09/2026, não uma sincronização do inventário do comerciante. Os preços importados são referências; o stock inicial é zero.

No painel:

1. Confirmar a marca, os direitos de uso das imagens e os dados reais dos produtos.
2. Validar preços e stock por produto. Só produtos validados com stock podem ser vendidos.
3. Preencher nome da empresa, NIF, morada, email, portes e condições de venda, privacidade e devoluções.
4. Verificar o número MB WAY e confirmar que a operação comercial pode usar o processo manual escolhido.
5. Ativar **Abrir a loja e aceitar encomendas reais**.

O servidor recusa a abertura se faltarem campos obrigatórios. Esse controlo verifica preenchimento; a revisão do conteúdo comercial e legal cabe ao operador. Não há faturação fiscal, reembolsos automáticos, integração com transportadora nem importação automática de fornecedores. Os reembolsos devem ser tratados fora da aplicação; o painel não permite cancelar encomendas já confirmadas como pagas.

## Publicar

Usar um servidor Node.js ou um contentor com **disco persistente**, HTTPS e uma única instância. SQLite e as sessões precisam de persistência. **GitHub Pages e funções sem disco persistente não executam esta loja completa.**

```sh
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
ORIGIN=https://o-teu-dominio.pt
DB_PATH=/app/storage/store.sqlite
```

O domínio e o alojamento ainda têm de ser configurados pelo operador. O repositório contém o código; não implica que exista uma loja pública em funcionamento.

### Docker

```sh
docker build -t elite-digital .
docker volume create elite-data
docker run --name elite-digital --restart unless-stopped \
  --env-file .env \
  -e HOST=0.0.0.0 -e DB_PATH=/app/storage/store.sqlite \
  -p 127.0.0.1:3000:3000 -v elite-data:/app/storage elite-digital
```

Colocar um proxy HTTPS à frente do serviço. Em produção, definir `NODE_ENV=production` e o domínio em `ORIGIN`; os cookies serão enviados apenas por HTTPS. Fazer cópias consistentes da base de dados com a API de backup do SQLite ou com a aplicação parada; incluir o armazenamento persistente nos backups. Não copiar apenas o ficheiro principal enquanto há gravações WAL em curso.

### Emails de recuperação

Configurar `RESEND_API_KEY` e `EMAIL_FROM` no ambiente, usando um domínio de envio verificado. Sem esses valores a recuperação mostra uma mensagem explícita de indisponibilidade. Nunca colocar a chave no código ou no GitHub.

## Testes

```sh
npm test
```

Testes de integração com uma base de dados temporária: autenticação, isolamento entre clientes, permissões administrativas, origem dos pedidos, abertura da loja, cálculo de preços, reserva e reposição de stock, repetição de pedidos, pagamentos manuais e envio. A porta 3198 é usada apenas pelos testes. Não há transferências financeiras durante os testes.

## Estrutura

```text
public/                 Interface e imagens locais
server.mjs              Servidor HTTP e API
lib.mjs                 SQLite, sessões, palavras-passe e transações
data/catalog.json       Catálogo inicial de referência
scripts/create-admin.mjs
tests/store.test.mjs
```

O ficheiro `.gitignore` exclui a base de dados, os dados de clientes, sessões e ficheiros `.env`. As palavras-passe são protegidas com scrypt, as sessões usam cookies HttpOnly, as alterações exigem a origem configurada e existe limitação de tentativas. Para maior escala, rever o armazenamento, os limites de tráfego por proxy e a operação de backups antes de aumentar o número de instâncias.

## Proveniência

Estrutura funcional inspirada no site indicado pelo utilizador. Código e interface criados para este projeto. Nomes comerciais, marcas e fotografias pertencem aos respetivos titulares; este repositório não atribui uma licença sobre esses conteúdos. As fontes de cada produto estão registadas em `data/catalog.json`.
