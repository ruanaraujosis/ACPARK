-- ATENCAO: arquivo gerado por tools/gerar-dump-estrutura.mjs (npm run dump:gerar).
-- Serve apenas para revisar diferencas de estrutura no Git -- nao edite a mao.
-- Para restaurar, use db/estrutura.dump com pg_restore (ver docs/DEPLOY_LOCAL.md).
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.10
-- Dumped by pg_dump version 17.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: processar_autopedido(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.processar_autopedido() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
    v_qtd_necessaria INTEGER;
    v_pedido_id INTEGER;
BEGIN
    -- 1. Verifica se a quantidade caiu abaixo do mínimo e se há um máximo definido
    IF NEW.quantidade < NEW.estoque_minimo AND NEW.estoque_maximo > 0 THEN
        v_qtd_necessaria := NEW.estoque_maximo - NEW.quantidade;

        -- 2. Procura se já existe um autopedido pendente para este PDV e Produto
        SELECT id INTO v_pedido_id
        FROM pedidos
        WHERE pdv_id = NEW.pdv_id
          AND sku_produto = NEW.sku_produto
          AND status = 'Pendente'  -- Ajuste aqui se a sua coluna de status usar outro nome (ex: 'Aberto')
          AND codigo_pedido LIKE 'AUTO-%'
        LIMIT 1;

        -- 3. Toma a decisão: Atualiza ou Cria
        IF v_pedido_id IS NOT NULL THEN
            -- Se JÁ EXISTE, apenas atualiza a quantidade para o novo volume necessário
            UPDATE pedidos
            SET quantidade_solicitada = v_qtd_necessaria
            WHERE id = v_pedido_id;
        ELSE
            -- Se NÃO EXISTE, cria um pedido novo do zero
            INSERT INTO pedidos (codigo_pedido, pdv_id, sku_produto, quantidade_solicitada, status, data_hora)
            VALUES (
                'AUTO-' || NEW.pdv_id || '-' || EXTRACT(EPOCH FROM NOW())::INTEGER, 
                NEW.pdv_id, 
                NEW.sku_produto, 
                v_qtd_necessaria, 
                'Pendente', 
                NOW()
            );
        END IF;
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: processar_baixa_estoque_orion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.processar_baixa_estoque_orion() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN
    IF NEW.tipo_operacao = 'VENDA' THEN
        -- Tira do estoque do PDV
        UPDATE estoque_pdv 
        SET quantidade = quantidade - NEW.quantidade_vendida
        WHERE pdv_id = NEW.pdv_id AND sku_produto = NEW.sku_produto;
        
    ELSIF NEW.tipo_operacao = 'DEVOLUCAO' THEN
        -- Devolve para o estoque do PDV
        UPDATE estoque_pdv 
        SET quantidade = quantidade + NEW.quantidade_vendida
        WHERE pdv_id = NEW.pdv_id AND sku_produto = NEW.sku_produto;
    END IF;

    -- Marca como processado
    UPDATE vendas_orion SET processado = TRUE WHERE id = NEW.id;
    
    RETURN NEW;
END;
$$;


--
-- Name: registrar_movimentacao_orion(text, text, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.registrar_movimentacao_orion(p_codigo_orion text, p_sku text, p_qtd integer, p_tipo text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
    v_pdv_id INTEGER;
BEGIN
    SELECT id INTO v_pdv_id FROM pdvs WHERE codigo_orion = p_codigo_orion;
    
    IF v_pdv_id IS NULL THEN
        RETURN '{"status": "erro", "mensagem": "PDV não encontrado"}'::jsonb;
    END IF;

    INSERT INTO vendas_orion (pdv_id, sku_produto, quantidade_vendida, tipo_operacao, processado)
    VALUES (v_pdv_id, p_sku, p_qtd, COALESCE(p_tipo, 'VENDA'), FALSE);

    RETURN '{"status": "sucesso", "mensagem": "Registrado"}'::jsonb;
END;
$$;


--
-- Name: verificar_estoque_minimo(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.verificar_estoque_minimo() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
    v_qtd_necessaria INTEGER;
    v_pedido_id INTEGER;
BEGIN
    -- TRAVA DE SEGURANÇA: Só executa se o produto estiver PERMITIDO (NEW.permitido = true)
    IF NEW.permitido = true AND NEW.quantidade < NEW.estoque_minimo AND NEW.estoque_maximo > 0 THEN
        
        -- Calcula o quanto falta para encher o estoque até o máximo
        v_qtd_necessaria := NEW.estoque_maximo - NEW.quantidade;

        -- Procura se já existe um autopedido ABERTO para este PDV e Produto
        SELECT id INTO v_pedido_id
        FROM pedidos
        WHERE pdv_id = NEW.pdv_id
          AND sku_produto = NEW.sku_produto
          AND LOWER(status) IN ('pendente', 'em andamento')
          AND codigo_pedido LIKE 'AUTO-%'
        LIMIT 1;

        -- Toma a decisão
        IF v_pedido_id IS NOT NULL THEN
            -- Se JÁ EXISTE, apenas ATUALIZA a quantidade
            UPDATE pedidos
            SET quantidade_solicitada = v_qtd_necessaria
            WHERE id = v_pedido_id;
        ELSE
            -- Se NÃO EXISTE nenhum em aberto, CRIA um novo autopedido do zero
            INSERT INTO pedidos (
                codigo_pedido, solicitante, pdv_id, sku_produto, 
                quantidade_solicitada, status, observacao, data_hora
            ) 
            VALUES (
                'AUTO-' || to_char(NOW() - INTERVAL '3 hours', 'YYYYMMDDHH24MISS'), 
                'SISTEMA (AUTOPEDIDO)', 
                NEW.pdv_id, 
                NEW.sku_produto, 
                v_qtd_necessaria, 
                'Pendente', 
                'Pedido automático gerado por atingir o estoque mínimo.', 
                NOW() - INTERVAL '3 hours'
            );
        END IF;
        
    END IF;
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: categorias; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categorias (
    id integer NOT NULL,
    nome text NOT NULL
);


--
-- Name: categorias_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.categorias_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: categorias_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.categorias_id_seq OWNED BY public.categorias.id;


--
-- Name: configuracoes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.configuracoes (
    chave text NOT NULL,
    valor text
);


--
-- Name: devolucao_avaria_fotos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.devolucao_avaria_fotos (
    id bigint NOT NULL,
    devolucao_id integer,
    item_id integer,
    draft_id character varying(120),
    owner_role character varying(40),
    owner_name character varying(120),
    owner_pdv_id integer,
    storage_key character varying(500) NOT NULL,
    original_name character varying(255),
    mime_type character varying(100) NOT NULL,
    size_bytes bigint NOT NULL,
    width integer,
    height integer,
    sha256 character varying(64),
    thumbnail_key character varying(500),
    uploaded_by character varying(120),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    linked_at timestamp without time zone,
    expires_at timestamp without time zone,
    deleted_at timestamp without time zone
);


--
-- Name: devolucao_avaria_fotos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.devolucao_avaria_fotos_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: devolucao_avaria_fotos_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.devolucao_avaria_fotos_id_seq OWNED BY public.devolucao_avaria_fotos.id;


--
-- Name: devolucao_avaria_historico; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.devolucao_avaria_historico (
    id integer NOT NULL,
    devolucao_id integer,
    usuario text,
    acao text NOT NULL,
    status_anterior text,
    novo_status text,
    quantidade integer DEFAULT 0,
    observacao text,
    origem text,
    criado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: devolucao_avaria_historico_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.devolucao_avaria_historico_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: devolucao_avaria_historico_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.devolucao_avaria_historico_id_seq OWNED BY public.devolucao_avaria_historico.id;


--
-- Name: devolucao_avaria_itens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.devolucao_avaria_itens (
    id integer NOT NULL,
    devolucao_id integer,
    sku_produto text,
    quantidade integer DEFAULT 0 NOT NULL,
    unidade_medida text DEFAULT 'UN'::text,
    motivo text NOT NULL,
    outro_motivo text,
    data_identificacao date,
    lote text,
    data_validade date,
    observacao text,
    fotos text,
    status_item text DEFAULT 'Enviar para o Almoxarifado'::text,
    quantidade_recebida integer DEFAULT 0,
    quantidade_aprovada integer DEFAULT 0,
    quantidade_recusada integer DEFAULT 0,
    motivo_divergencia text,
    observacao_interna text,
    retirada_responsavel text,
    retirada_em timestamp without time zone,
    retirada_usuario_almoxarifado text,
    retirada_confirmada boolean DEFAULT false,
    omie_quantidade_processada integer DEFAULT 0,
    criado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    atualizado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    retirada_assinatura text,
    manual_quantidade_processada integer DEFAULT 0,
    movimento_manual_status text DEFAULT 'Pendente'::text
);


--
-- Name: devolucao_avaria_itens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.devolucao_avaria_itens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: devolucao_avaria_itens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.devolucao_avaria_itens_id_seq OWNED BY public.devolucao_avaria_itens.id;


--
-- Name: devolucao_idempotencia; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.devolucao_idempotencia (
    id integer NOT NULL,
    idempotency_key text NOT NULL,
    operation_type text NOT NULL,
    user_role text NOT NULL,
    user_name text NOT NULL,
    pdv_id integer,
    devolucao_id integer,
    request_hash text NOT NULL,
    response_status integer,
    response_body jsonb,
    processing_status text DEFAULT 'PROCESSING'::text NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    completed_at timestamp without time zone
);


--
-- Name: devolucao_idempotencia_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.devolucao_idempotencia_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: devolucao_idempotencia_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.devolucao_idempotencia_id_seq OWNED BY public.devolucao_idempotencia.id;


--
-- Name: devolucoes_avaria; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.devolucoes_avaria (
    id integer NOT NULL,
    codigo_devolucao text NOT NULL,
    pdv_id integer,
    sku_produto text,
    quantidade integer NOT NULL,
    unidade_medida text DEFAULT 'UN'::text,
    motivo text NOT NULL,
    outro_motivo text,
    data_identificacao date NOT NULL,
    lote text,
    data_validade date,
    observacao text,
    fotos text,
    usuario_solicitante text,
    status text DEFAULT 'Enviar para o Almoxarifado'::text,
    quantidade_recebida integer DEFAULT 0,
    quantidade_aprovada integer DEFAULT 0,
    quantidade_recusada integer DEFAULT 0,
    motivo_divergencia text,
    observacao_interna text,
    omie_status text DEFAULT 'Aguardando integração'::text,
    omie_request_id text,
    omie_response text,
    omie_error text,
    omie_attempts integer DEFAULT 0,
    omie_quantidade_processada integer DEFAULT 0,
    criado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    atualizado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    recebido_em timestamp without time zone,
    finalizado_em timestamp without time zone,
    cancelado_em timestamp without time zone,
    assinatura_imagem text,
    assinatura_confirmada_em timestamp without time zone,
    responsavel_entrega_nome text,
    responsavel_entrega_documento text,
    responsavel_entrega_cargo text,
    entrega_em timestamp without time zone,
    recebido_por_usuario text,
    recebido_sessao text,
    recebido_ip text,
    verificado boolean DEFAULT false,
    estornado_em timestamp without time zone,
    estornado_por text,
    motivo_estorno text,
    manual_quantidade_processada integer DEFAULT 0,
    movimento_manual_status text DEFAULT 'Pendente'::text
);


--
-- Name: devolucoes_avaria_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.devolucoes_avaria_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: devolucoes_avaria_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.devolucoes_avaria_id_seq OWNED BY public.devolucoes_avaria.id;


--
-- Name: estoque_avarias; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.estoque_avarias (
    id integer NOT NULL,
    devolucao_id integer,
    pdv_id integer,
    sku_produto text,
    quantidade integer DEFAULT 0,
    status text DEFAULT 'Em análise'::text,
    criado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    atualizado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: estoque_avarias_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.estoque_avarias_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: estoque_avarias_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.estoque_avarias_id_seq OWNED BY public.estoque_avarias.id;


--
-- Name: estoque_pdv; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.estoque_pdv (
    id integer NOT NULL,
    pdv_id integer,
    sku_produto text,
    quantidade integer DEFAULT 0,
    estoque_minimo integer DEFAULT 0,
    estoque_maximo integer DEFAULT 0,
    permitido boolean DEFAULT false,
    saldo_omie numeric DEFAULT 0,
    quantidade_reservada_acpark numeric DEFAULT 0,
    saldo_disponivel_acpark numeric GENERATED ALWAYS AS ((COALESCE(saldo_omie, (0)::numeric) - COALESCE(quantidade_reservada_acpark, (0)::numeric))) STORED,
    ultima_sincronizacao timestamp without time zone,
    sincronizacao_status text DEFAULT 'MANUAL'::text
);


--
-- Name: estoque_pdv_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.estoque_pdv_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: estoque_pdv_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.estoque_pdv_id_seq OWNED BY public.estoque_pdv.id;


--
-- Name: integration_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_attempts (
    id bigint NOT NULL,
    job_id bigint,
    integration_id bigint,
    status text NOT NULL,
    error_message text,
    response_summary jsonb,
    started_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    finished_at timestamp without time zone
);


--
-- Name: integration_attempts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.integration_attempts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integration_attempts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.integration_attempts_id_seq OWNED BY public.integration_attempts.id;


--
-- Name: integration_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_audit_logs (
    id bigint NOT NULL,
    integration_id bigint,
    action text NOT NULL,
    actor text,
    details jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: integration_audit_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.integration_audit_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integration_audit_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.integration_audit_logs_id_seq OWNED BY public.integration_audit_logs.id;


--
-- Name: integration_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_credentials (
    id bigint NOT NULL,
    integration_id bigint NOT NULL,
    credential_key text NOT NULL,
    encrypted_value text NOT NULL,
    masked_value text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: integration_credentials_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.integration_credentials_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integration_credentials_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.integration_credentials_id_seq OWNED BY public.integration_credentials.id;


--
-- Name: integration_factor_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_factor_decisions (
    id bigint NOT NULL,
    integration_id bigint NOT NULL,
    external_product_id text NOT NULL,
    status text NOT NULL,
    fator_sugerido integer,
    fator_decidido integer,
    decidido_por text,
    decidido_em timestamp without time zone,
    escrito_em timestamp without time zone,
    erro text,
    criado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    atualizado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    valor_anterior text,
    payload jsonb,
    resposta jsonb,
    operacao text,
    evidencia jsonb
);


--
-- Name: integration_factor_decisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.integration_factor_decisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integration_factor_decisions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.integration_factor_decisions_id_seq OWNED BY public.integration_factor_decisions.id;


--
-- Name: integration_factor_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_factor_evidence (
    id bigint NOT NULL,
    integration_id bigint NOT NULL,
    external_product_id text NOT NULL,
    fator integer NOT NULL,
    vezes integer DEFAULT 0 NOT NULL,
    primeira_em date,
    ultima_em date,
    documento jsonb,
    atualizado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: integration_factor_evidence_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.integration_factor_evidence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integration_factor_evidence_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.integration_factor_evidence_id_seq OWNED BY public.integration_factor_evidence.id;


--
-- Name: integration_factor_sheet; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_factor_sheet (
    id bigint NOT NULL,
    integration_id bigint NOT NULL,
    nome_operacao text NOT NULL,
    fator integer,
    divergente boolean DEFAULT false NOT NULL,
    valores_por_aba jsonb,
    secao text,
    external_product_id text,
    vinculado_por text,
    vinculado_em timestamp without time zone,
    importado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    atualizado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: integration_factor_sheet_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.integration_factor_sheet_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integration_factor_sheet_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.integration_factor_sheet_id_seq OWNED BY public.integration_factor_sheet.id;


--
-- Name: integration_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_jobs (
    id bigint NOT NULL,
    integration_id bigint,
    job_type text NOT NULL,
    status text DEFAULT 'PENDENTE'::text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb,
    result jsonb,
    attempts integer DEFAULT 0 NOT NULL,
    current_page integer DEFAULT 1,
    cursor text,
    date_from timestamp without time zone,
    date_to timestamp without time zone,
    last_external_id text,
    last_processed_at timestamp without time zone,
    next_run_at timestamp without time zone,
    last_error text,
    idempotency_key text,
    locked_at timestamp without time zone,
    locked_by text,
    completed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    priority text DEFAULT 'NORMAL'::text NOT NULL,
    priority_rank integer DEFAULT 50 NOT NULL,
    scheduled_for timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    started_at timestamp without time zone
);


--
-- Name: integration_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.integration_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integration_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.integration_jobs_id_seq OWNED BY public.integration_jobs.id;


--
-- Name: integration_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_metrics (
    id bigint NOT NULL,
    integration_id bigint,
    metric_name text NOT NULL,
    metric_value numeric DEFAULT 0 NOT NULL,
    labels jsonb DEFAULT '{}'::jsonb,
    recorded_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: integration_metrics_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.integration_metrics_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integration_metrics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.integration_metrics_id_seq OWNED BY public.integration_metrics.id;


--
-- Name: integration_runtime_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_runtime_state (
    integration_id bigint NOT NULL,
    circuit_state text DEFAULT 'CLOSED'::text NOT NULL,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    opened_at timestamp without time zone,
    half_open_after timestamp without time zone,
    last_request_at timestamp without time zone,
    request_window_start timestamp without time zone,
    request_count integer DEFAULT 0 NOT NULL,
    max_concurrent_requests integer DEFAULT 1 NOT NULL,
    max_requests_per_second integer DEFAULT 2 NOT NULL,
    minimum_interval_ms integer DEFAULT 500 NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: integration_stock_launches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_stock_launches (
    id bigint NOT NULL,
    integration_id bigint,
    codigo_pedido text NOT NULL,
    pedido_item_id bigint,
    sku_produto text NOT NULL,
    pdv_id integer,
    quantidade numeric NOT NULL,
    local_origem text,
    local_destino text,
    evento text NOT NULL,
    idempotency_key text NOT NULL,
    modo text DEFAULT 'SIMULACAO'::text NOT NULL,
    status text DEFAULT 'PENDENTE'::text NOT NULL,
    payload jsonb,
    resposta jsonb,
    external_id text,
    erro text,
    tentativas integer DEFAULT 0 NOT NULL,
    enviado_em timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: integration_stock_launches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.integration_stock_launches_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integration_stock_launches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.integration_stock_launches_id_seq OWNED BY public.integration_stock_launches.id;


--
-- Name: integration_sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_sync_state (
    id bigint NOT NULL,
    integration_id bigint,
    scope text NOT NULL,
    last_success_at timestamp without time zone,
    last_attempt_at timestamp without time zone,
    last_movement_id text,
    last_page integer DEFAULT 1,
    last_cursor text,
    overlap_start_at timestamp without time zone,
    last_error text,
    stats jsonb DEFAULT '{}'::jsonb,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: integration_sync_state_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.integration_sync_state_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integration_sync_state_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.integration_sync_state_id_seq OWNED BY public.integration_sync_state.id;


--
-- Name: integration_webhooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_webhooks (
    id bigint NOT NULL,
    integration_id bigint,
    provider text NOT NULL,
    event_type text,
    signature_valid boolean DEFAULT false,
    raw_payload jsonb,
    headers jsonb,
    status text DEFAULT 'RECEBIDO'::text NOT NULL,
    processing_error text,
    received_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    processed_at timestamp without time zone
);


--
-- Name: integration_webhooks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.integration_webhooks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integration_webhooks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.integration_webhooks_id_seq OWNED BY public.integration_webhooks.id;


--
-- Name: integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integrations (
    id bigint NOT NULL,
    nome text NOT NULL,
    provedor text NOT NULL,
    tipo text NOT NULL,
    ambiente text DEFAULT 'PRODUCAO'::text NOT NULL,
    url_base text,
    empresa_vinculada text,
    ativo boolean DEFAULT true NOT NULL,
    status text DEFAULT 'PENDENTE'::text NOT NULL,
    ultima_sincronizacao timestamp without time zone,
    last_error text,
    last_connection_test_at timestamp without time zone,
    last_connection_duration_ms integer,
    last_connection_message text,
    stock_mode text DEFAULT 'MANUAL'::text NOT NULL,
    sync_intervals jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by text,
    updated_by text,
    configuracao jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: integrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.integrations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.integrations_id_seq OWNED BY public.integrations.id;


--
-- Name: omie_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.omie_jobs (
    id bigint NOT NULL,
    operation_key character varying(180) NOT NULL,
    entity_type character varying(50) NOT NULL,
    entity_id bigint NOT NULL,
    pdv_id integer,
    product_sku text,
    movement_type character varying(80) NOT NULL,
    quantity numeric NOT NULL,
    payload jsonb,
    status character varying(30) DEFAULT 'PENDING'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    external_id character varying(150),
    last_error text,
    response_summary jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    processing_started_at timestamp without time zone,
    completed_at timestamp without time zone,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: omie_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.omie_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: omie_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.omie_jobs_id_seq OWNED BY public.omie_jobs.id;


--
-- Name: omie_stock_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.omie_stock_locations (
    id bigint NOT NULL,
    integration_id bigint,
    omie_location_id text NOT NULL,
    code text,
    name text NOT NULL,
    description text,
    active boolean DEFAULT true NOT NULL,
    company text,
    raw_payload jsonb,
    synced_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: omie_stock_locations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.omie_stock_locations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: omie_stock_locations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.omie_stock_locations_id_seq OWNED BY public.omie_stock_locations.id;


--
-- Name: order_alert_sounds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_alert_sounds (
    id bigint NOT NULL,
    sound_key character varying(100) NOT NULL,
    display_name character varying(150) NOT NULL,
    storage_path character varying(500),
    mime_type character varying(100),
    size_bytes bigint DEFAULT 0,
    duration_seconds numeric,
    is_system boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: order_alert_sounds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_alert_sounds_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: order_alert_sounds_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.order_alert_sounds_id_seq OWNED BY public.order_alert_sounds.id;


--
-- Name: pdv_categorias; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pdv_categorias (
    id integer NOT NULL,
    pdv_id integer,
    categoria text NOT NULL
);


--
-- Name: pdv_categorias_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pdv_categorias_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pdv_categorias_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pdv_categorias_id_seq OWNED BY public.pdv_categorias.id;


--
-- Name: pdv_stock_location_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pdv_stock_location_mappings (
    id bigint NOT NULL,
    pdv_acpark_id integer,
    integration_id bigint,
    omie_location_id text NOT NULL,
    omie_location_name text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: pdv_stock_location_mappings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pdv_stock_location_mappings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pdv_stock_location_mappings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pdv_stock_location_mappings_id_seq OWNED BY public.pdv_stock_location_mappings.id;


--
-- Name: pdvs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pdvs (
    id integer NOT NULL,
    nome text,
    senha text,
    is_cozinha boolean DEFAULT false,
    codigo_orion text,
    categoria text
);


--
-- Name: pdvs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pdvs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pdvs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pdvs_id_seq OWNED BY public.pdvs.id;


--
-- Name: pedido_auditoria; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pedido_auditoria (
    id integer NOT NULL,
    codigo_pedido text NOT NULL,
    acao text NOT NULL,
    usuario text,
    observacao text,
    dados jsonb DEFAULT '{}'::jsonb NOT NULL,
    criado_em timestamp without time zone DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo'::text)
);


--
-- Name: pedido_auditoria_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pedido_auditoria_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pedido_auditoria_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pedido_auditoria_id_seq OWNED BY public.pedido_auditoria.id;


--
-- Name: pedido_idempotencia; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pedido_idempotencia (
    id integer NOT NULL,
    idempotency_key text NOT NULL,
    pdv_id integer,
    codigo_pedido text,
    status text DEFAULT 'processing'::text,
    criado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    atualizado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: pedido_idempotencia_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pedido_idempotencia_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pedido_idempotencia_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pedido_idempotencia_id_seq OWNED BY public.pedido_idempotencia.id;


--
-- Name: pedido_rascunhos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pedido_rascunhos (
    pdv_id integer NOT NULL,
    solicitante text,
    observacao text,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    atualizado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: pedidos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pedidos (
    id integer NOT NULL,
    codigo_pedido text,
    solicitante text,
    sku_produto text,
    pdv_id integer,
    quantidade_solicitada integer,
    quantidade_liberada integer DEFAULT 0,
    status text DEFAULT 'Pendente'::text,
    observacao text,
    data_hora timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    criado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    em_andamento_em timestamp without time zone,
    liberado_em timestamp without time zone,
    print_status text DEFAULT 'nao_impresso'::text,
    print_attempts integer DEFAULT 0,
    print_requested_at timestamp without time zone,
    printed_at timestamp without time zone,
    print_error text,
    print_version integer DEFAULT 0,
    version integer DEFAULT 1,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    pronto_retirada_em timestamp without time zone,
    retirada_assinatura text,
    retirada_responsavel text,
    retirada_observacao text,
    retirada_em timestamp without time zone,
    retirada_usuario_almoxarifado text,
    pedido_editado boolean DEFAULT false,
    pedido_editado_em timestamp without time zone,
    pedido_editado_por text,
    print_job_id text,
    printer_name text,
    paper_size text DEFAULT '80mm'::text,
    release_mode text,
    pedido_reaberto_finalizado boolean DEFAULT false,
    item_origem text DEFAULT 'PDV'::text,
    reversao_pdv_motivo text,
    reversao_pdv_observacao text,
    reversao_pdv_em timestamp without time zone,
    reversao_pdv_por text,
    reenviado_pdv_em timestamp without time zone
);


--
-- Name: pedidos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pedidos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pedidos_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pedidos_id_seq OWNED BY public.pedidos.id;


--
-- Name: product_integration_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_integration_mappings (
    id bigint NOT NULL,
    integration_id bigint,
    sku_produto text,
    external_product_id text NOT NULL,
    external_code text,
    integration_code text,
    product_type text DEFAULT 'REVENDA'::text,
    unit text DEFAULT 'UN'::text,
    family text,
    ean text,
    ncm text,
    price numeric,
    stock_control text,
    review_status text DEFAULT 'PENDENTE_REVISAO'::text NOT NULL,
    raw_payload jsonb,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    fator_conversao integer,
    embalagem text,
    fator_status text,
    fator_conteudo_bruto text,
    fator_lido_em timestamp without time zone
);


--
-- Name: product_integration_mappings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_integration_mappings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_integration_mappings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_integration_mappings_id_seq OWNED BY public.product_integration_mappings.id;


--
-- Name: product_sync_temperature; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_sync_temperature (
    integration_id bigint NOT NULL,
    external_product_id text NOT NULL,
    sku_produto text,
    temperature text DEFAULT 'FRIO'::text NOT NULL,
    reason text,
    last_movement_at timestamp without time zone,
    last_classified_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: produto_categorias; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.produto_categorias (
    id integer NOT NULL,
    sku_produto text,
    categoria text NOT NULL
);


--
-- Name: produto_categorias_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.produto_categorias_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: produto_categorias_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.produto_categorias_id_seq OWNED BY public.produto_categorias.id;


--
-- Name: produtos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.produtos (
    sku text NOT NULL,
    nome text NOT NULL,
    qtd_total integer DEFAULT 0,
    estoque_minimo integer DEFAULT 0,
    is_materia_prima boolean DEFAULT false,
    estoque_central integer DEFAULT 0,
    ativo boolean DEFAULT true,
    categoria text,
    origem text DEFAULT 'manual'::text,
    saldo_omie numeric DEFAULT 0,
    quantidade_reservada_acpark numeric DEFAULT 0,
    saldo_disponivel_acpark numeric DEFAULT 0,
    ultima_sincronizacao timestamp without time zone,
    sincronizacao_status text DEFAULT 'Manual'::text,
    stock_mode text DEFAULT 'MANUAL'::text NOT NULL
);


--
-- Name: stock_movement_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_movement_items (
    id bigint NOT NULL,
    movement_id bigint,
    sku_produto text,
    quantity numeric NOT NULL,
    unit text DEFAULT 'UN'::text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: stock_movement_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_movement_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_movement_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_movement_items_id_seq OWNED BY public.stock_movement_items.id;


--
-- Name: stock_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_movements (
    id bigint NOT NULL,
    omie_movement_id text,
    operation_type text NOT NULL,
    origin_system text NOT NULL,
    external_reference text,
    idempotency_key text,
    pdv_id integer,
    omie_location_id text,
    status text DEFAULT 'PENDENTE'::text NOT NULL,
    movement_date timestamp without time zone,
    synced_at timestamp without time zone,
    error_message text,
    raw_payload jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: stock_movements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_movements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_movements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_movements_id_seq OWNED BY public.stock_movements.id;


--
-- Name: stock_reconciliation_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_reconciliation_items (
    id bigint NOT NULL,
    reconciliation_id bigint,
    integration_id bigint,
    pdv_id integer,
    sku_produto text,
    omie_location_id text,
    difference_type text NOT NULL,
    status text DEFAULT 'PENDENTE'::text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb,
    reviewed_by text,
    reviewed_at timestamp without time zone,
    note text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    saldo_local numeric DEFAULT 0,
    saldo_omie numeric DEFAULT 0,
    diferenca numeric DEFAULT 0
);


--
-- Name: stock_reconciliation_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_reconciliation_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_reconciliation_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_reconciliation_items_id_seq OWNED BY public.stock_reconciliation_items.id;


--
-- Name: stock_reconciliations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_reconciliations (
    id bigint NOT NULL,
    integration_id bigint,
    status text DEFAULT 'PENDENTE'::text NOT NULL,
    differences_count integer DEFAULT 0 NOT NULL,
    started_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    finished_at timestamp without time zone,
    summary jsonb,
    error_message text
);


--
-- Name: stock_reconciliations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_reconciliations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_reconciliations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_reconciliations_id_seq OWNED BY public.stock_reconciliations.id;


--
-- Name: stock_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_snapshots (
    id bigint NOT NULL,
    integration_id bigint,
    pdv_id integer,
    sku_produto text,
    omie_location_id text,
    saldo_omie numeric DEFAULT 0 NOT NULL,
    quantidade_reservada_acpark numeric DEFAULT 0 NOT NULL,
    saldo_disponivel_acpark numeric DEFAULT 0 NOT NULL,
    sync_status text DEFAULT 'SINCRONIZADO'::text NOT NULL,
    synced_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    raw_payload jsonb,
    saldo_local numeric DEFAULT 0,
    snapshot_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: stock_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_snapshots_id_seq OWNED BY public.stock_snapshots.id;


--
-- Name: user_order_alert_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_order_alert_preferences (
    id bigint NOT NULL,
    user_key text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    sound_id character varying(100) DEFAULT 'default'::character varying NOT NULL,
    volume integer DEFAULT 65 NOT NULL,
    visual_notifications boolean DEFAULT true NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    repeat_mode character varying(40) DEFAULT 'three_times'::character varying NOT NULL,
    repeat_interval_seconds integer DEFAULT 5 NOT NULL,
    stop_on_view boolean DEFAULT true NOT NULL,
    stop_on_service_start boolean DEFAULT true NOT NULL
);


--
-- Name: user_order_alert_preferences_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_order_alert_preferences_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_order_alert_preferences_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_order_alert_preferences_id_seq OWNED BY public.user_order_alert_preferences.id;


--
-- Name: categorias id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categorias ALTER COLUMN id SET DEFAULT nextval('public.categorias_id_seq'::regclass);


--
-- Name: devolucao_avaria_fotos id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucao_avaria_fotos ALTER COLUMN id SET DEFAULT nextval('public.devolucao_avaria_fotos_id_seq'::regclass);


--
-- Name: devolucao_avaria_historico id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucao_avaria_historico ALTER COLUMN id SET DEFAULT nextval('public.devolucao_avaria_historico_id_seq'::regclass);


--
-- Name: devolucao_avaria_itens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucao_avaria_itens ALTER COLUMN id SET DEFAULT nextval('public.devolucao_avaria_itens_id_seq'::regclass);


--
-- Name: devolucao_idempotencia id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucao_idempotencia ALTER COLUMN id SET DEFAULT nextval('public.devolucao_idempotencia_id_seq'::regclass);


--
-- Name: devolucoes_avaria id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucoes_avaria ALTER COLUMN id SET DEFAULT nextval('public.devolucoes_avaria_id_seq'::regclass);


--
-- Name: estoque_avarias id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estoque_avarias ALTER COLUMN id SET DEFAULT nextval('public.estoque_avarias_id_seq'::regclass);


--
-- Name: estoque_pdv id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estoque_pdv ALTER COLUMN id SET DEFAULT nextval('public.estoque_pdv_id_seq'::regclass);


--
-- Name: integration_attempts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_attempts ALTER COLUMN id SET DEFAULT nextval('public.integration_attempts_id_seq'::regclass);


--
-- Name: integration_audit_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_audit_logs ALTER COLUMN id SET DEFAULT nextval('public.integration_audit_logs_id_seq'::regclass);


--
-- Name: integration_credentials id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_credentials ALTER COLUMN id SET DEFAULT nextval('public.integration_credentials_id_seq'::regclass);


--
-- Name: integration_factor_decisions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_factor_decisions ALTER COLUMN id SET DEFAULT nextval('public.integration_factor_decisions_id_seq'::regclass);


--
-- Name: integration_factor_evidence id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_factor_evidence ALTER COLUMN id SET DEFAULT nextval('public.integration_factor_evidence_id_seq'::regclass);


--
-- Name: integration_factor_sheet id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_factor_sheet ALTER COLUMN id SET DEFAULT nextval('public.integration_factor_sheet_id_seq'::regclass);


--
-- Name: integration_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_jobs ALTER COLUMN id SET DEFAULT nextval('public.integration_jobs_id_seq'::regclass);


--
-- Name: integration_metrics id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_metrics ALTER COLUMN id SET DEFAULT nextval('public.integration_metrics_id_seq'::regclass);


--
-- Name: integration_stock_launches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_stock_launches ALTER COLUMN id SET DEFAULT nextval('public.integration_stock_launches_id_seq'::regclass);


--
-- Name: integration_sync_state id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_sync_state ALTER COLUMN id SET DEFAULT nextval('public.integration_sync_state_id_seq'::regclass);


--
-- Name: integration_webhooks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_webhooks ALTER COLUMN id SET DEFAULT nextval('public.integration_webhooks_id_seq'::regclass);


--
-- Name: integrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations ALTER COLUMN id SET DEFAULT nextval('public.integrations_id_seq'::regclass);


--
-- Name: omie_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omie_jobs ALTER COLUMN id SET DEFAULT nextval('public.omie_jobs_id_seq'::regclass);


--
-- Name: omie_stock_locations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omie_stock_locations ALTER COLUMN id SET DEFAULT nextval('public.omie_stock_locations_id_seq'::regclass);


--
-- Name: order_alert_sounds id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_alert_sounds ALTER COLUMN id SET DEFAULT nextval('public.order_alert_sounds_id_seq'::regclass);


--
-- Name: pdv_categorias id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdv_categorias ALTER COLUMN id SET DEFAULT nextval('public.pdv_categorias_id_seq'::regclass);


--
-- Name: pdv_stock_location_mappings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdv_stock_location_mappings ALTER COLUMN id SET DEFAULT nextval('public.pdv_stock_location_mappings_id_seq'::regclass);


--
-- Name: pdvs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdvs ALTER COLUMN id SET DEFAULT nextval('public.pdvs_id_seq'::regclass);


--
-- Name: pedido_auditoria id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedido_auditoria ALTER COLUMN id SET DEFAULT nextval('public.pedido_auditoria_id_seq'::regclass);


--
-- Name: pedido_idempotencia id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedido_idempotencia ALTER COLUMN id SET DEFAULT nextval('public.pedido_idempotencia_id_seq'::regclass);


--
-- Name: pedidos id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedidos ALTER COLUMN id SET DEFAULT nextval('public.pedidos_id_seq'::regclass);


--
-- Name: product_integration_mappings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_integration_mappings ALTER COLUMN id SET DEFAULT nextval('public.product_integration_mappings_id_seq'::regclass);


--
-- Name: produto_categorias id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.produto_categorias ALTER COLUMN id SET DEFAULT nextval('public.produto_categorias_id_seq'::regclass);


--
-- Name: stock_movement_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movement_items ALTER COLUMN id SET DEFAULT nextval('public.stock_movement_items_id_seq'::regclass);


--
-- Name: stock_movements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements ALTER COLUMN id SET DEFAULT nextval('public.stock_movements_id_seq'::regclass);


--
-- Name: stock_reconciliation_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_reconciliation_items ALTER COLUMN id SET DEFAULT nextval('public.stock_reconciliation_items_id_seq'::regclass);


--
-- Name: stock_reconciliations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_reconciliations ALTER COLUMN id SET DEFAULT nextval('public.stock_reconciliations_id_seq'::regclass);


--
-- Name: stock_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_snapshots ALTER COLUMN id SET DEFAULT nextval('public.stock_snapshots_id_seq'::regclass);


--
-- Name: user_order_alert_preferences id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_order_alert_preferences ALTER COLUMN id SET DEFAULT nextval('public.user_order_alert_preferences_id_seq'::regclass);


--
-- Name: categorias categorias_nome_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categorias
    ADD CONSTRAINT categorias_nome_key UNIQUE (nome);


--
-- Name: categorias categorias_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categorias
    ADD CONSTRAINT categorias_pkey PRIMARY KEY (id);


--
-- Name: configuracoes configuracoes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.configuracoes
    ADD CONSTRAINT configuracoes_pkey PRIMARY KEY (chave);


--
-- Name: devolucao_avaria_fotos devolucao_avaria_fotos_item_id_sha256_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucao_avaria_fotos
    ADD CONSTRAINT devolucao_avaria_fotos_item_id_sha256_key UNIQUE (item_id, sha256);


--
-- Name: devolucao_avaria_fotos devolucao_avaria_fotos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucao_avaria_fotos
    ADD CONSTRAINT devolucao_avaria_fotos_pkey PRIMARY KEY (id);


--
-- Name: devolucao_avaria_historico devolucao_avaria_historico_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucao_avaria_historico
    ADD CONSTRAINT devolucao_avaria_historico_pkey PRIMARY KEY (id);


--
-- Name: devolucao_avaria_itens devolucao_avaria_itens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucao_avaria_itens
    ADD CONSTRAINT devolucao_avaria_itens_pkey PRIMARY KEY (id);


--
-- Name: devolucao_idempotencia devolucao_idempotencia_idempotency_key_operation_type_user__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucao_idempotencia
    ADD CONSTRAINT devolucao_idempotencia_idempotency_key_operation_type_user__key UNIQUE (idempotency_key, operation_type, user_role, user_name);


--
-- Name: devolucao_idempotencia devolucao_idempotencia_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucao_idempotencia
    ADD CONSTRAINT devolucao_idempotencia_pkey PRIMARY KEY (id);


--
-- Name: devolucoes_avaria devolucoes_avaria_codigo_devolucao_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucoes_avaria
    ADD CONSTRAINT devolucoes_avaria_codigo_devolucao_key UNIQUE (codigo_devolucao);


--
-- Name: devolucoes_avaria devolucoes_avaria_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucoes_avaria
    ADD CONSTRAINT devolucoes_avaria_pkey PRIMARY KEY (id);


--
-- Name: estoque_avarias estoque_avarias_devolucao_id_sku_produto_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estoque_avarias
    ADD CONSTRAINT estoque_avarias_devolucao_id_sku_produto_key UNIQUE (devolucao_id, sku_produto);


--
-- Name: estoque_avarias estoque_avarias_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estoque_avarias
    ADD CONSTRAINT estoque_avarias_pkey PRIMARY KEY (id);


--
-- Name: estoque_pdv estoque_pdv_pdv_id_sku_produto_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estoque_pdv
    ADD CONSTRAINT estoque_pdv_pdv_id_sku_produto_key UNIQUE (pdv_id, sku_produto);


--
-- Name: estoque_pdv estoque_pdv_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estoque_pdv
    ADD CONSTRAINT estoque_pdv_pkey PRIMARY KEY (id);


--
-- Name: integration_attempts integration_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_attempts
    ADD CONSTRAINT integration_attempts_pkey PRIMARY KEY (id);


--
-- Name: integration_audit_logs integration_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_audit_logs
    ADD CONSTRAINT integration_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: integration_credentials integration_credentials_integration_id_credential_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_credentials
    ADD CONSTRAINT integration_credentials_integration_id_credential_key_key UNIQUE (integration_id, credential_key);


--
-- Name: integration_credentials integration_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_credentials
    ADD CONSTRAINT integration_credentials_pkey PRIMARY KEY (id);


--
-- Name: integration_factor_decisions integration_factor_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_factor_decisions
    ADD CONSTRAINT integration_factor_decisions_pkey PRIMARY KEY (id);


--
-- Name: integration_factor_evidence integration_factor_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_factor_evidence
    ADD CONSTRAINT integration_factor_evidence_pkey PRIMARY KEY (id);


--
-- Name: integration_factor_sheet integration_factor_sheet_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_factor_sheet
    ADD CONSTRAINT integration_factor_sheet_pkey PRIMARY KEY (id);


--
-- Name: integration_jobs integration_jobs_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_jobs
    ADD CONSTRAINT integration_jobs_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: integration_jobs integration_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_jobs
    ADD CONSTRAINT integration_jobs_pkey PRIMARY KEY (id);


--
-- Name: integration_metrics integration_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_metrics
    ADD CONSTRAINT integration_metrics_pkey PRIMARY KEY (id);


--
-- Name: integration_runtime_state integration_runtime_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_runtime_state
    ADD CONSTRAINT integration_runtime_state_pkey PRIMARY KEY (integration_id);


--
-- Name: integration_stock_launches integration_stock_launches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_stock_launches
    ADD CONSTRAINT integration_stock_launches_pkey PRIMARY KEY (id);


--
-- Name: integration_sync_state integration_sync_state_integration_id_scope_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_sync_state
    ADD CONSTRAINT integration_sync_state_integration_id_scope_key UNIQUE (integration_id, scope);


--
-- Name: integration_sync_state integration_sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_sync_state
    ADD CONSTRAINT integration_sync_state_pkey PRIMARY KEY (id);


--
-- Name: integration_webhooks integration_webhooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_webhooks
    ADD CONSTRAINT integration_webhooks_pkey PRIMARY KEY (id);


--
-- Name: integrations integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations
    ADD CONSTRAINT integrations_pkey PRIMARY KEY (id);


--
-- Name: omie_jobs omie_jobs_operation_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omie_jobs
    ADD CONSTRAINT omie_jobs_operation_key_key UNIQUE (operation_key);


--
-- Name: omie_jobs omie_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omie_jobs
    ADD CONSTRAINT omie_jobs_pkey PRIMARY KEY (id);


--
-- Name: omie_stock_locations omie_stock_locations_integration_id_omie_location_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omie_stock_locations
    ADD CONSTRAINT omie_stock_locations_integration_id_omie_location_id_key UNIQUE (integration_id, omie_location_id);


--
-- Name: omie_stock_locations omie_stock_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omie_stock_locations
    ADD CONSTRAINT omie_stock_locations_pkey PRIMARY KEY (id);


--
-- Name: order_alert_sounds order_alert_sounds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_alert_sounds
    ADD CONSTRAINT order_alert_sounds_pkey PRIMARY KEY (id);


--
-- Name: order_alert_sounds order_alert_sounds_sound_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_alert_sounds
    ADD CONSTRAINT order_alert_sounds_sound_key_key UNIQUE (sound_key);


--
-- Name: pdv_categorias pdv_categorias_pdv_id_categoria_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdv_categorias
    ADD CONSTRAINT pdv_categorias_pdv_id_categoria_key UNIQUE (pdv_id, categoria);


--
-- Name: pdv_categorias pdv_categorias_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdv_categorias
    ADD CONSTRAINT pdv_categorias_pkey PRIMARY KEY (id);


--
-- Name: pdv_stock_location_mappings pdv_stock_location_mappings_pdv_acpark_id_integration_id_om_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdv_stock_location_mappings
    ADD CONSTRAINT pdv_stock_location_mappings_pdv_acpark_id_integration_id_om_key UNIQUE (pdv_acpark_id, integration_id, omie_location_id);


--
-- Name: pdv_stock_location_mappings pdv_stock_location_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdv_stock_location_mappings
    ADD CONSTRAINT pdv_stock_location_mappings_pkey PRIMARY KEY (id);


--
-- Name: pdvs pdvs_codigo_orion_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdvs
    ADD CONSTRAINT pdvs_codigo_orion_key UNIQUE (codigo_orion);


--
-- Name: pdvs pdvs_nome_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdvs
    ADD CONSTRAINT pdvs_nome_key UNIQUE (nome);


--
-- Name: pdvs pdvs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdvs
    ADD CONSTRAINT pdvs_pkey PRIMARY KEY (id);


--
-- Name: pedido_auditoria pedido_auditoria_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedido_auditoria
    ADD CONSTRAINT pedido_auditoria_pkey PRIMARY KEY (id);


--
-- Name: pedido_idempotencia pedido_idempotencia_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedido_idempotencia
    ADD CONSTRAINT pedido_idempotencia_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: pedido_idempotencia pedido_idempotencia_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedido_idempotencia
    ADD CONSTRAINT pedido_idempotencia_pkey PRIMARY KEY (id);


--
-- Name: pedido_rascunhos pedido_rascunhos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedido_rascunhos
    ADD CONSTRAINT pedido_rascunhos_pkey PRIMARY KEY (pdv_id);


--
-- Name: pedidos pedidos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedidos
    ADD CONSTRAINT pedidos_pkey PRIMARY KEY (id);


--
-- Name: product_integration_mappings product_integration_mappings_integration_id_external_produc_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_integration_mappings
    ADD CONSTRAINT product_integration_mappings_integration_id_external_produc_key UNIQUE (integration_id, external_product_id);


--
-- Name: product_integration_mappings product_integration_mappings_integration_id_sku_produto_ext_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_integration_mappings
    ADD CONSTRAINT product_integration_mappings_integration_id_sku_produto_ext_key UNIQUE (integration_id, sku_produto, external_product_id);


--
-- Name: product_integration_mappings product_integration_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_integration_mappings
    ADD CONSTRAINT product_integration_mappings_pkey PRIMARY KEY (id);


--
-- Name: product_sync_temperature product_sync_temperature_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_sync_temperature
    ADD CONSTRAINT product_sync_temperature_pkey PRIMARY KEY (integration_id, external_product_id);


--
-- Name: produto_categorias produto_categorias_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.produto_categorias
    ADD CONSTRAINT produto_categorias_pkey PRIMARY KEY (id);


--
-- Name: produto_categorias produto_categorias_sku_produto_categoria_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.produto_categorias
    ADD CONSTRAINT produto_categorias_sku_produto_categoria_key UNIQUE (sku_produto, categoria);


--
-- Name: produtos produtos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.produtos
    ADD CONSTRAINT produtos_pkey PRIMARY KEY (sku);


--
-- Name: stock_movement_items stock_movement_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movement_items
    ADD CONSTRAINT stock_movement_items_pkey PRIMARY KEY (id);


--
-- Name: stock_movements stock_movements_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: stock_movements stock_movements_omie_movement_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_omie_movement_id_key UNIQUE (omie_movement_id);


--
-- Name: stock_movements stock_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_pkey PRIMARY KEY (id);


--
-- Name: stock_reconciliation_items stock_reconciliation_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_reconciliation_items
    ADD CONSTRAINT stock_reconciliation_items_pkey PRIMARY KEY (id);


--
-- Name: stock_reconciliations stock_reconciliations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_reconciliations
    ADD CONSTRAINT stock_reconciliations_pkey PRIMARY KEY (id);


--
-- Name: stock_snapshots stock_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_snapshots
    ADD CONSTRAINT stock_snapshots_pkey PRIMARY KEY (id);


--
-- Name: user_order_alert_preferences user_order_alert_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_order_alert_preferences
    ADD CONSTRAINT user_order_alert_preferences_pkey PRIMARY KEY (id);


--
-- Name: user_order_alert_preferences user_order_alert_preferences_user_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_order_alert_preferences
    ADD CONSTRAINT user_order_alert_preferences_user_key_key UNIQUE (user_key);


--
-- Name: idx_devolucao_avaria_fotos_devolucao; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devolucao_avaria_fotos_devolucao ON public.devolucao_avaria_fotos USING btree (devolucao_id);


--
-- Name: idx_devolucao_avaria_fotos_draft; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devolucao_avaria_fotos_draft ON public.devolucao_avaria_fotos USING btree (draft_id, owner_pdv_id);


--
-- Name: idx_devolucao_avaria_fotos_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devolucao_avaria_fotos_hash ON public.devolucao_avaria_fotos USING btree (sha256);


--
-- Name: idx_devolucao_avaria_fotos_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devolucao_avaria_fotos_item ON public.devolucao_avaria_fotos USING btree (item_id);


--
-- Name: idx_devolucao_avaria_historico_devolucao; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devolucao_avaria_historico_devolucao ON public.devolucao_avaria_historico USING btree (devolucao_id, criado_em DESC);


--
-- Name: idx_devolucao_avaria_itens_devolucao; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devolucao_avaria_itens_devolucao ON public.devolucao_avaria_itens USING btree (devolucao_id);


--
-- Name: idx_devolucao_avaria_itens_sku; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devolucao_avaria_itens_sku ON public.devolucao_avaria_itens USING btree (sku_produto);


--
-- Name: idx_devolucao_avaria_itens_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devolucao_avaria_itens_status ON public.devolucao_avaria_itens USING btree (status_item);


--
-- Name: idx_devolucao_idempotencia_devolucao; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devolucao_idempotencia_devolucao ON public.devolucao_idempotencia USING btree (devolucao_id, operation_type);


--
-- Name: idx_devolucoes_avaria_omie; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devolucoes_avaria_omie ON public.devolucoes_avaria USING btree (omie_status);


--
-- Name: idx_devolucoes_avaria_pdv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devolucoes_avaria_pdv ON public.devolucoes_avaria USING btree (pdv_id, criado_em DESC);


--
-- Name: idx_devolucoes_avaria_produto; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devolucoes_avaria_produto ON public.devolucoes_avaria USING btree (sku_produto);


--
-- Name: idx_devolucoes_avaria_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devolucoes_avaria_status ON public.devolucoes_avaria USING btree (status, criado_em DESC);


--
-- Name: idx_estoque_avarias_devolucao; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_estoque_avarias_devolucao ON public.estoque_avarias USING btree (devolucao_id);


--
-- Name: idx_factor_decisions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_factor_decisions_status ON public.integration_factor_decisions USING btree (integration_id, status);


--
-- Name: idx_factor_evidence_produto; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_factor_evidence_produto ON public.integration_factor_evidence USING btree (integration_id, external_product_id);


--
-- Name: idx_factor_sheet_produto; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_factor_sheet_produto ON public.integration_factor_sheet USING btree (integration_id, external_product_id);


--
-- Name: idx_integration_jobs_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_jobs_priority ON public.integration_jobs USING btree (status, priority_rank DESC, created_at);


--
-- Name: idx_integration_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_jobs_status ON public.integration_jobs USING btree (status, next_run_at);


--
-- Name: idx_integration_jobs_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_jobs_type ON public.integration_jobs USING btree (job_type, created_at DESC);


--
-- Name: idx_integration_metrics_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_metrics_lookup ON public.integration_metrics USING btree (integration_id, metric_name, recorded_at DESC);


--
-- Name: idx_integration_sync_state_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_sync_state_lookup ON public.integration_sync_state USING btree (integration_id, scope);


--
-- Name: idx_integrations_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integrations_provider ON public.integrations USING btree (provedor, ativo);


--
-- Name: idx_mappings_fator_pendente; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mappings_fator_pendente ON public.product_integration_mappings USING btree (integration_id, fator_lido_em NULLS FIRST);


--
-- Name: idx_mappings_fator_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mappings_fator_status ON public.product_integration_mappings USING btree (integration_id, fator_status);


--
-- Name: idx_mappings_sku_ativo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mappings_sku_ativo ON public.product_integration_mappings USING btree (sku_produto) WHERE active;


--
-- Name: idx_omie_jobs_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_omie_jobs_entity ON public.omie_jobs USING btree (entity_type, entity_id);


--
-- Name: idx_omie_jobs_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_omie_jobs_product ON public.omie_jobs USING btree (product_sku);


--
-- Name: idx_omie_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_omie_jobs_status ON public.omie_jobs USING btree (status, created_at DESC);


--
-- Name: idx_omie_stock_locations_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_omie_stock_locations_lookup ON public.omie_stock_locations USING btree (integration_id, active, name);


--
-- Name: idx_pedidos_pdv_data; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pedidos_pdv_data ON public.pedidos USING btree (pdv_id, data_hora DESC);


--
-- Name: idx_pedidos_print_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pedidos_print_status ON public.pedidos USING btree (print_status, status);


--
-- Name: idx_pedidos_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pedidos_status ON public.pedidos USING btree (status);


--
-- Name: idx_product_integration_external_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_product_integration_external_unique ON public.product_integration_mappings USING btree (integration_id, external_product_id);


--
-- Name: idx_produto_categorias_categoria; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_produto_categorias_categoria ON public.produto_categorias USING btree (categoria);


--
-- Name: idx_stock_launches_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_stock_launches_idempotency ON public.integration_stock_launches USING btree (idempotency_key);


--
-- Name: idx_stock_launches_pedido; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_launches_pedido ON public.integration_stock_launches USING btree (codigo_pedido);


--
-- Name: idx_stock_launches_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_launches_status ON public.integration_stock_launches USING btree (status, created_at);


--
-- Name: idx_stock_movements_origin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_movements_origin ON public.stock_movements USING btree (origin_system, operation_type, movement_date DESC);


--
-- Name: idx_stock_reconciliation_items_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_reconciliation_items_status ON public.stock_reconciliation_items USING btree (integration_id, status, difference_type);


--
-- Name: idx_stock_snapshots_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_snapshots_lookup ON public.stock_snapshots USING btree (pdv_id, sku_produto, synced_at DESC);


--
-- Name: idx_stock_snapshots_sku; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_snapshots_sku ON public.stock_snapshots USING btree (sku_produto, snapshot_at DESC);


--
-- Name: uq_factor_decisions; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_factor_decisions ON public.integration_factor_decisions USING btree (integration_id, external_product_id);


--
-- Name: uq_factor_evidence; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_factor_evidence ON public.integration_factor_evidence USING btree (integration_id, external_product_id, fator);


--
-- Name: uq_factor_sheet_nome; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_factor_sheet_nome ON public.integration_factor_sheet USING btree (integration_id, nome_operacao);


--
-- Name: estoque_pdv trg_verificar_estoque_minimo; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_verificar_estoque_minimo AFTER UPDATE ON public.estoque_pdv FOR EACH ROW EXECUTE FUNCTION public.verificar_estoque_minimo();


--
-- Name: devolucao_avaria_fotos devolucao_avaria_fotos_devolucao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucao_avaria_fotos
    ADD CONSTRAINT devolucao_avaria_fotos_devolucao_id_fkey FOREIGN KEY (devolucao_id) REFERENCES public.devolucoes_avaria(id) ON DELETE CASCADE;


--
-- Name: devolucao_avaria_fotos devolucao_avaria_fotos_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucao_avaria_fotos
    ADD CONSTRAINT devolucao_avaria_fotos_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.devolucao_avaria_itens(id) ON DELETE CASCADE;


--
-- Name: devolucao_avaria_fotos devolucao_avaria_fotos_owner_pdv_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucao_avaria_fotos
    ADD CONSTRAINT devolucao_avaria_fotos_owner_pdv_id_fkey FOREIGN KEY (owner_pdv_id) REFERENCES public.pdvs(id) ON DELETE SET NULL;


--
-- Name: devolucao_avaria_historico devolucao_avaria_historico_devolucao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucao_avaria_historico
    ADD CONSTRAINT devolucao_avaria_historico_devolucao_id_fkey FOREIGN KEY (devolucao_id) REFERENCES public.devolucoes_avaria(id) ON DELETE CASCADE;


--
-- Name: devolucao_avaria_itens devolucao_avaria_itens_devolucao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucao_avaria_itens
    ADD CONSTRAINT devolucao_avaria_itens_devolucao_id_fkey FOREIGN KEY (devolucao_id) REFERENCES public.devolucoes_avaria(id) ON DELETE CASCADE;


--
-- Name: devolucao_avaria_itens devolucao_avaria_itens_sku_produto_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucao_avaria_itens
    ADD CONSTRAINT devolucao_avaria_itens_sku_produto_fkey FOREIGN KEY (sku_produto) REFERENCES public.produtos(sku) ON DELETE SET NULL;


--
-- Name: devolucao_idempotencia devolucao_idempotencia_devolucao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucao_idempotencia
    ADD CONSTRAINT devolucao_idempotencia_devolucao_id_fkey FOREIGN KEY (devolucao_id) REFERENCES public.devolucoes_avaria(id) ON DELETE SET NULL;


--
-- Name: devolucao_idempotencia devolucao_idempotencia_pdv_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucao_idempotencia
    ADD CONSTRAINT devolucao_idempotencia_pdv_id_fkey FOREIGN KEY (pdv_id) REFERENCES public.pdvs(id) ON DELETE SET NULL;


--
-- Name: devolucoes_avaria devolucoes_avaria_pdv_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucoes_avaria
    ADD CONSTRAINT devolucoes_avaria_pdv_id_fkey FOREIGN KEY (pdv_id) REFERENCES public.pdvs(id) ON DELETE SET NULL;


--
-- Name: devolucoes_avaria devolucoes_avaria_sku_produto_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devolucoes_avaria
    ADD CONSTRAINT devolucoes_avaria_sku_produto_fkey FOREIGN KEY (sku_produto) REFERENCES public.produtos(sku) ON DELETE SET NULL;


--
-- Name: estoque_avarias estoque_avarias_devolucao_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estoque_avarias
    ADD CONSTRAINT estoque_avarias_devolucao_id_fkey FOREIGN KEY (devolucao_id) REFERENCES public.devolucoes_avaria(id) ON DELETE CASCADE;


--
-- Name: estoque_avarias estoque_avarias_pdv_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estoque_avarias
    ADD CONSTRAINT estoque_avarias_pdv_id_fkey FOREIGN KEY (pdv_id) REFERENCES public.pdvs(id) ON DELETE SET NULL;


--
-- Name: estoque_avarias estoque_avarias_sku_produto_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estoque_avarias
    ADD CONSTRAINT estoque_avarias_sku_produto_fkey FOREIGN KEY (sku_produto) REFERENCES public.produtos(sku) ON DELETE SET NULL;


--
-- Name: integration_attempts integration_attempts_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_attempts
    ADD CONSTRAINT integration_attempts_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.integrations(id) ON DELETE SET NULL;


--
-- Name: integration_attempts integration_attempts_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_attempts
    ADD CONSTRAINT integration_attempts_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.integration_jobs(id) ON DELETE CASCADE;


--
-- Name: integration_audit_logs integration_audit_logs_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_audit_logs
    ADD CONSTRAINT integration_audit_logs_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.integrations(id) ON DELETE SET NULL;


--
-- Name: integration_credentials integration_credentials_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_credentials
    ADD CONSTRAINT integration_credentials_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.integrations(id) ON DELETE CASCADE;


--
-- Name: integration_jobs integration_jobs_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_jobs
    ADD CONSTRAINT integration_jobs_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.integrations(id) ON DELETE SET NULL;


--
-- Name: integration_metrics integration_metrics_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_metrics
    ADD CONSTRAINT integration_metrics_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.integrations(id) ON DELETE SET NULL;


--
-- Name: integration_runtime_state integration_runtime_state_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_runtime_state
    ADD CONSTRAINT integration_runtime_state_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.integrations(id) ON DELETE CASCADE;


--
-- Name: integration_sync_state integration_sync_state_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_sync_state
    ADD CONSTRAINT integration_sync_state_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.integrations(id) ON DELETE CASCADE;


--
-- Name: integration_webhooks integration_webhooks_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_webhooks
    ADD CONSTRAINT integration_webhooks_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.integrations(id) ON DELETE SET NULL;


--
-- Name: omie_jobs omie_jobs_pdv_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omie_jobs
    ADD CONSTRAINT omie_jobs_pdv_id_fkey FOREIGN KEY (pdv_id) REFERENCES public.pdvs(id) ON DELETE SET NULL;


--
-- Name: omie_jobs omie_jobs_product_sku_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omie_jobs
    ADD CONSTRAINT omie_jobs_product_sku_fkey FOREIGN KEY (product_sku) REFERENCES public.produtos(sku) ON DELETE SET NULL;


--
-- Name: omie_stock_locations omie_stock_locations_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.omie_stock_locations
    ADD CONSTRAINT omie_stock_locations_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.integrations(id) ON DELETE CASCADE;


--
-- Name: pdv_categorias pdv_categorias_pdv_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdv_categorias
    ADD CONSTRAINT pdv_categorias_pdv_id_fkey FOREIGN KEY (pdv_id) REFERENCES public.pdvs(id) ON DELETE CASCADE;


--
-- Name: pdv_stock_location_mappings pdv_stock_location_mappings_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdv_stock_location_mappings
    ADD CONSTRAINT pdv_stock_location_mappings_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.integrations(id) ON DELETE CASCADE;


--
-- Name: pdv_stock_location_mappings pdv_stock_location_mappings_pdv_acpark_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdv_stock_location_mappings
    ADD CONSTRAINT pdv_stock_location_mappings_pdv_acpark_id_fkey FOREIGN KEY (pdv_acpark_id) REFERENCES public.pdvs(id) ON DELETE CASCADE;


--
-- Name: pedido_idempotencia pedido_idempotencia_pdv_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedido_idempotencia
    ADD CONSTRAINT pedido_idempotencia_pdv_id_fkey FOREIGN KEY (pdv_id) REFERENCES public.pdvs(id) ON DELETE CASCADE;


--
-- Name: pedido_rascunhos pedido_rascunhos_pdv_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pedido_rascunhos
    ADD CONSTRAINT pedido_rascunhos_pdv_id_fkey FOREIGN KEY (pdv_id) REFERENCES public.pdvs(id) ON DELETE CASCADE;


--
-- Name: product_integration_mappings product_integration_mappings_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_integration_mappings
    ADD CONSTRAINT product_integration_mappings_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.integrations(id) ON DELETE CASCADE;


--
-- Name: product_integration_mappings product_integration_mappings_sku_produto_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_integration_mappings
    ADD CONSTRAINT product_integration_mappings_sku_produto_fkey FOREIGN KEY (sku_produto) REFERENCES public.produtos(sku) ON DELETE CASCADE;


--
-- Name: product_sync_temperature product_sync_temperature_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_sync_temperature
    ADD CONSTRAINT product_sync_temperature_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.integrations(id) ON DELETE CASCADE;


--
-- Name: product_sync_temperature product_sync_temperature_sku_produto_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_sync_temperature
    ADD CONSTRAINT product_sync_temperature_sku_produto_fkey FOREIGN KEY (sku_produto) REFERENCES public.produtos(sku) ON DELETE SET NULL;


--
-- Name: produto_categorias produto_categorias_sku_produto_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.produto_categorias
    ADD CONSTRAINT produto_categorias_sku_produto_fkey FOREIGN KEY (sku_produto) REFERENCES public.produtos(sku) ON DELETE CASCADE;


--
-- Name: stock_movement_items stock_movement_items_movement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movement_items
    ADD CONSTRAINT stock_movement_items_movement_id_fkey FOREIGN KEY (movement_id) REFERENCES public.stock_movements(id) ON DELETE CASCADE;


--
-- Name: stock_movement_items stock_movement_items_sku_produto_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movement_items
    ADD CONSTRAINT stock_movement_items_sku_produto_fkey FOREIGN KEY (sku_produto) REFERENCES public.produtos(sku) ON DELETE SET NULL;


--
-- Name: stock_movements stock_movements_pdv_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_pdv_id_fkey FOREIGN KEY (pdv_id) REFERENCES public.pdvs(id) ON DELETE SET NULL;


--
-- Name: stock_reconciliation_items stock_reconciliation_items_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_reconciliation_items
    ADD CONSTRAINT stock_reconciliation_items_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.integrations(id) ON DELETE SET NULL;


--
-- Name: stock_reconciliation_items stock_reconciliation_items_pdv_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_reconciliation_items
    ADD CONSTRAINT stock_reconciliation_items_pdv_id_fkey FOREIGN KEY (pdv_id) REFERENCES public.pdvs(id) ON DELETE SET NULL;


--
-- Name: stock_reconciliation_items stock_reconciliation_items_reconciliation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_reconciliation_items
    ADD CONSTRAINT stock_reconciliation_items_reconciliation_id_fkey FOREIGN KEY (reconciliation_id) REFERENCES public.stock_reconciliations(id) ON DELETE CASCADE;


--
-- Name: stock_reconciliation_items stock_reconciliation_items_sku_produto_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_reconciliation_items
    ADD CONSTRAINT stock_reconciliation_items_sku_produto_fkey FOREIGN KEY (sku_produto) REFERENCES public.produtos(sku) ON DELETE SET NULL;


--
-- Name: stock_reconciliations stock_reconciliations_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_reconciliations
    ADD CONSTRAINT stock_reconciliations_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.integrations(id) ON DELETE SET NULL;


--
-- Name: stock_snapshots stock_snapshots_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_snapshots
    ADD CONSTRAINT stock_snapshots_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.integrations(id) ON DELETE SET NULL;


--
-- Name: stock_snapshots stock_snapshots_pdv_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_snapshots
    ADD CONSTRAINT stock_snapshots_pdv_id_fkey FOREIGN KEY (pdv_id) REFERENCES public.pdvs(id) ON DELETE SET NULL;


--
-- Name: stock_snapshots stock_snapshots_sku_produto_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_snapshots
    ADD CONSTRAINT stock_snapshots_sku_produto_fkey FOREIGN KEY (sku_produto) REFERENCES public.produtos(sku) ON DELETE SET NULL;


--
-- Name: configuracoes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.configuracoes ENABLE ROW LEVEL SECURITY;

--
-- Name: estoque_pdv; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.estoque_pdv ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_credentials; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_credentials ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_metrics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_metrics ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_runtime_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_runtime_state ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_sync_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_sync_state ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_webhooks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_webhooks ENABLE ROW LEVEL SECURITY;

--
-- Name: integrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;

--
-- Name: pdvs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pdvs ENABLE ROW LEVEL SECURITY;

--
-- Name: pedidos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pedidos ENABLE ROW LEVEL SECURITY;

--
-- Name: produtos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.produtos ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--


