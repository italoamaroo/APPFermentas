-- OPCIONAL: dados de exemplo (os mesmos do painel original).
-- Rode depois do schema.sql apenas se quiser testar com dados fictícios.

insert into public.fornecedores (nome, contato) values
  ('Vonder Ferramentas', '(81) 3231-4455'),
  ('Makita Brasil', '(11) 4004-8000'),
  ('Tramontina Ferramentas', '(54) 3457-3000')
on conflict do nothing;

insert into public.funcionarios (matricula, nome, funcao, setor, telefone) values
  ('3021', 'Edivaldo dos Santos', 'Pedreiro', 'Obra Muribeca', '81999990001'),
  ('1187', 'José Cláudio', 'Eletricista', 'Obra Muribeca', '81999990002'),
  ('2044', 'Ricardo Alves', 'Carpinteiro', 'Obra Muribeca', null),
  ('0876', 'Wilson Berto', 'Servente', 'Dois Irmãos', null)
on conflict (matricula) do nothing;

insert into public.ferramentas (codigo, nome, tipo, classificacao, fornecedor, patrimonio, site, status, observacoes) values
  ('FRT-001', 'Furadeira Martelete SDS 65M', 'Elétrica', 'proprio', 'Makita Brasil', 'PAT-1102', 'Almoxarifado Muribeca', 'disponivel', null),
  ('FRT-002', 'Parafusadeira de Impacto 18V', 'Elétrica', 'proprio', 'Makita Brasil', 'PAT-1103', 'Almoxarifado Muribeca', 'disponivel', null),
  ('FRT-003', 'Jogo de Chaves Combinadas 6-22mm', 'Manual', 'proprio', 'Tramontina Ferramentas', 'PAT-0087', 'Almoxarifado Muribeca', 'disponivel', null),
  ('FRT-004', 'Alicate Universal 8"', 'Manual', 'proprio', 'Tramontina Ferramentas', 'PAT-0091', 'Almoxarifado Muribeca', 'disponivel', null),
  ('FRT-005', 'Chave Ajustável 12"', 'Manual', 'proprio', 'Vonder Ferramentas', 'PAT-0102', 'Dois Irmãos', 'disponivel', null),
  ('FRT-006', 'Betoneira 400L', 'Equipamento', 'alugado', 'Vonder Ferramentas', 'PAT-2201', 'Dois Irmãos', 'manutencao', 'Motor com ruído — aguardando técnico'),
  ('FRT-007', 'Nível a Laser', 'Elétrica', 'proprio', 'Makita Brasil', 'PAT-1140', 'Almoxarifado Muribeca', 'disponivel', null),
  ('FRT-008', 'Capacete de Segurança', 'EPI', 'proprio', 'Vonder Ferramentas', 'PAT-0500', 'Dois Irmãos', 'disponivel', null)
on conflict (codigo) do nothing;
