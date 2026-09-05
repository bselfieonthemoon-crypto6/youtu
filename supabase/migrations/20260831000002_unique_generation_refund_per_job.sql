-- A job may be refunded at most once. The refund RPC updates the balance and
-- inserts the ledger row in one transaction, so a duplicate insert violation
-- also rolls back the duplicate balance increase.

CREATE UNIQUE INDEX credit_transactions_one_generation_refund_per_job
  ON public.credit_transactions (job_id)
  WHERE transaction_type = 'generation_refund'
    AND job_id IS NOT NULL;
