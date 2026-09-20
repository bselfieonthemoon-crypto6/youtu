export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  langgraph: {
    Tables: {
      checkpoint_blobs: {
        Row: {
          blob: string | null;
          channel: string;
          checkpoint_ns: string;
          thread_id: string;
          type: string;
          version: string;
        };
        Insert: {
          blob?: string | null;
          channel: string;
          checkpoint_ns?: string;
          thread_id: string;
          type: string;
          version: string;
        };
        Update: {
          blob?: string | null;
          channel?: string;
          checkpoint_ns?: string;
          thread_id?: string;
          type?: string;
          version?: string;
        };
        Relationships: [];
      };
      checkpoint_migrations: {
        Row: {
          v: number;
        };
        Insert: {
          v: number;
        };
        Update: {
          v?: number;
        };
        Relationships: [];
      };
      checkpoint_writes: {
        Row: {
          blob: string;
          channel: string;
          checkpoint_id: string;
          checkpoint_ns: string;
          idx: number;
          task_id: string;
          thread_id: string;
          type: string | null;
        };
        Insert: {
          blob: string;
          channel: string;
          checkpoint_id: string;
          checkpoint_ns?: string;
          idx: number;
          task_id: string;
          thread_id: string;
          type?: string | null;
        };
        Update: {
          blob?: string;
          channel?: string;
          checkpoint_id?: string;
          checkpoint_ns?: string;
          idx?: number;
          task_id?: string;
          thread_id?: string;
          type?: string | null;
        };
        Relationships: [];
      };
      checkpoints: {
        Row: {
          checkpoint: Json;
          checkpoint_id: string;
          checkpoint_ns: string;
          metadata: Json;
          parent_checkpoint_id: string | null;
          thread_id: string;
          type: string | null;
        };
        Insert: {
          checkpoint: Json;
          checkpoint_id: string;
          checkpoint_ns?: string;
          metadata?: Json;
          parent_checkpoint_id?: string | null;
          thread_id: string;
          type?: string | null;
        };
        Update: {
          checkpoint?: Json;
          checkpoint_id?: string;
          checkpoint_ns?: string;
          metadata?: Json;
          parent_checkpoint_id?: string | null;
          thread_id?: string;
          type?: string | null;
        };
        Relationships: [];
      };
      store: {
        Row: {
          created_at: string | null;
          expires_at: string | null;
          key: string;
          namespace_path: string;
          updated_at: string | null;
          value: Json;
        };
        Insert: {
          created_at?: string | null;
          expires_at?: string | null;
          key: string;
          namespace_path: string;
          updated_at?: string | null;
          value: Json;
        };
        Update: {
          created_at?: string | null;
          expires_at?: string | null;
          key?: string;
          namespace_path?: string;
          updated_at?: string | null;
          value?: Json;
        };
        Relationships: [];
      };
      store_migrations: {
        Row: {
          v: number;
        };
        Insert: {
          v: number;
        };
        Update: {
          v?: number;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      agent_runs: {
        Row: {
          completed_at: string | null;
          created_at: string;
          created_by: string | null;
          error_code: string | null;
          error_message: string | null;
          execution_mode: string;
          id: string;
          model: string | null;
          session_id: string;
          started_at: string | null;
          status: string;
          thread_id: string;
          updated_at: string;
        };
        Insert: {
          completed_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          execution_mode?: string;
          id?: string;
          model?: string | null;
          session_id: string;
          started_at?: string | null;
          status: string;
          thread_id: string;
          updated_at?: string;
        };
        Update: {
          completed_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          execution_mode?: string;
          id?: string;
          model?: string | null;
          session_id?: string;
          started_at?: string | null;
          status?: string;
          thread_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "agent_runs_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "chat_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      asset_objects: {
        Row: {
          bucket: string;
          byte_size: number | null;
          created_at: string;
          created_by: string | null;
          deletion_pending_at: string | null;
          gc_claim_token: string | null;
          gc_claimed_at: string | null;
          gc_eligible_at: string | null;
          id: string;
          mime_type: string | null;
          object_path: string;
          project_id: string | null;
          scope: string;
          workspace_id: string | null;
        };
        Insert: {
          bucket: string;
          byte_size?: number | null;
          created_at?: string;
          created_by?: string | null;
          deletion_pending_at?: string | null;
          gc_claim_token?: string | null;
          gc_claimed_at?: string | null;
          gc_eligible_at?: string | null;
          id?: string;
          mime_type?: string | null;
          object_path: string;
          project_id?: string | null;
          scope?: string;
          workspace_id?: string | null;
        };
        Update: {
          bucket?: string;
          byte_size?: number | null;
          created_at?: string;
          created_by?: string | null;
          deletion_pending_at?: string | null;
          gc_claim_token?: string | null;
          gc_claimed_at?: string | null;
          gc_eligible_at?: string | null;
          id?: string;
          mime_type?: string | null;
          object_path?: string;
          project_id?: string | null;
          scope?: string;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "asset_objects_project_workspace_fkey";
            columns: ["project_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id", "workspace_id"];
          },
          {
            foreignKeyName: "asset_objects_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      asset_references: {
        Row: {
          asset_id: string;
          canvas_id: string;
          created_at: string;
          element_id: string;
          workspace_id: string;
        };
        Insert: {
          asset_id: string;
          canvas_id: string;
          created_at?: string;
          element_id: string;
          workspace_id: string;
        };
        Update: {
          asset_id?: string;
          canvas_id?: string;
          created_at?: string;
          element_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "asset_references_asset_id_fkey";
            columns: ["asset_id"];
            isOneToOne: false;
            referencedRelation: "asset_objects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "asset_references_canvas_id_fkey";
            columns: ["canvas_id"];
            isOneToOne: false;
            referencedRelation: "canvases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "asset_references_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      background_jobs: {
        Row: {
          attempt_count: number;
          canceled_at: string | null;
          canvas_id: string | null;
          completed_at: string | null;
          created_at: string;
          created_by: string;
          credits_cost: number | null;
          credits_transaction_id: string | null;
          design_id: string | null;
          error_code: string | null;
          error_message: string | null;
          failed_at: string | null;
          id: string;
          job_type: Database["public"]["Enums"]["background_job_type"];
          max_attempts: number;
          payload: Json;
          project_id: string | null;
          queue_name: string;
          result: Json | null;
          session_id: string | null;
          started_at: string | null;
          status: Database["public"]["Enums"]["background_job_status"];
          target_kind: string | null;
          thread_id: string | null;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          attempt_count?: number;
          canceled_at?: string | null;
          canvas_id?: string | null;
          completed_at?: string | null;
          created_at?: string;
          created_by: string;
          credits_cost?: number | null;
          credits_transaction_id?: string | null;
          design_id?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          failed_at?: string | null;
          id?: string;
          job_type: Database["public"]["Enums"]["background_job_type"];
          max_attempts?: number;
          payload?: Json;
          project_id?: string | null;
          queue_name: string;
          result?: Json | null;
          session_id?: string | null;
          started_at?: string | null;
          status?: Database["public"]["Enums"]["background_job_status"];
          target_kind?: string | null;
          thread_id?: string | null;
          updated_at?: string;
          workspace_id: string;
        };
        Update: {
          attempt_count?: number;
          canceled_at?: string | null;
          canvas_id?: string | null;
          completed_at?: string | null;
          created_at?: string;
          created_by?: string;
          credits_cost?: number | null;
          credits_transaction_id?: string | null;
          design_id?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          failed_at?: string | null;
          id?: string;
          job_type?: Database["public"]["Enums"]["background_job_type"];
          max_attempts?: number;
          payload?: Json;
          project_id?: string | null;
          queue_name?: string;
          result?: Json | null;
          session_id?: string | null;
          started_at?: string | null;
          status?: Database["public"]["Enums"]["background_job_status"];
          target_kind?: string | null;
          thread_id?: string | null;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "background_jobs_canvas_id_fkey";
            columns: ["canvas_id"];
            isOneToOne: false;
            referencedRelation: "canvases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "background_jobs_design_id_fkey";
            columns: ["design_id"];
            isOneToOne: false;
            referencedRelation: "design_documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "background_jobs_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "background_jobs_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "chat_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "background_jobs_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      brand_kit_assets: {
        Row: {
          asset_type: Database["public"]["Enums"]["brand_kit_asset_type"];
          created_at: string;
          display_name: string;
          file_url: string | null;
          id: string;
          kit_id: string;
          metadata: Json | null;
          role: string | null;
          sort_order: number;
          text_content: string | null;
          updated_at: string;
        };
        Insert: {
          asset_type: Database["public"]["Enums"]["brand_kit_asset_type"];
          created_at?: string;
          display_name?: string;
          file_url?: string | null;
          id?: string;
          kit_id: string;
          metadata?: Json | null;
          role?: string | null;
          sort_order?: number;
          text_content?: string | null;
          updated_at?: string;
        };
        Update: {
          asset_type?: Database["public"]["Enums"]["brand_kit_asset_type"];
          created_at?: string;
          display_name?: string;
          file_url?: string | null;
          id?: string;
          kit_id?: string;
          metadata?: Json | null;
          role?: string | null;
          sort_order?: number;
          text_content?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "brand_kit_assets_kit_id_fkey";
            columns: ["kit_id"];
            isOneToOne: false;
            referencedRelation: "brand_kits";
            referencedColumns: ["id"];
          },
        ];
      };
      brand_kits: {
        Row: {
          cover_url: string | null;
          created_at: string;
          guidance_text: string | null;
          id: string;
          is_default: boolean;
          name: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          cover_url?: string | null;
          created_at?: string;
          guidance_text?: string | null;
          id?: string;
          is_default?: boolean;
          name?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          cover_url?: string | null;
          created_at?: string;
          guidance_text?: string | null;
          id?: string;
          is_default?: boolean;
          name?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      canvases: {
        Row: {
          content: Json;
          created_at: string;
          created_by: string | null;
          id: string;
          is_primary: boolean;
          name: string;
          project_id: string;
          revision: number;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          content?: Json;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_primary?: boolean;
          name: string;
          project_id: string;
          revision?: number;
          updated_at?: string;
          workspace_id: string;
        };
        Update: {
          content?: Json;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_primary?: boolean;
          name?: string;
          project_id?: string;
          revision?: number;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "canvases_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "canvases_project_workspace_fkey";
            columns: ["project_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id", "workspace_id"];
          },
        ];
      };
      catalog_mutation_requests: {
        Row: {
          actor_user_id: string;
          completed_at: string | null;
          created_at: string;
          entity_id: string | null;
          entity_kind: string;
          input_hash: string;
          operation: string;
          request_id: string;
          result: Json | null;
        };
        Insert: {
          actor_user_id: string;
          completed_at?: string | null;
          created_at?: string;
          entity_id?: string | null;
          entity_kind: string;
          input_hash: string;
          operation: string;
          request_id: string;
          result?: Json | null;
        };
        Update: {
          actor_user_id?: string;
          completed_at?: string | null;
          created_at?: string;
          entity_id?: string | null;
          entity_kind?: string;
          input_hash?: string;
          operation?: string;
          request_id?: string;
          result?: Json | null;
        };
        Relationships: [];
      };
      chat_messages: {
        Row: {
          content: string;
          content_blocks: Json | null;
          created_at: string;
          id: string;
          role: string;
          session_id: string;
          tool_activities: Json | null;
        };
        Insert: {
          content?: string;
          content_blocks?: Json | null;
          created_at?: string;
          id?: string;
          role: string;
          session_id: string;
          tool_activities?: Json | null;
        };
        Update: {
          content?: string;
          content_blocks?: Json | null;
          created_at?: string;
          id?: string;
          role?: string;
          session_id?: string;
          tool_activities?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "chat_messages_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "chat_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      chat_sessions: {
        Row: {
          canvas_id: string;
          created_at: string;
          created_by: string | null;
          id: string;
          thread_id: string | null;
          title: string;
          updated_at: string;
        };
        Insert: {
          canvas_id: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          thread_id?: string | null;
          title?: string;
          updated_at?: string;
        };
        Update: {
          canvas_id?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          thread_id?: string | null;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "chat_sessions_canvas_id_fkey";
            columns: ["canvas_id"];
            isOneToOne: false;
            referencedRelation: "canvases";
            referencedColumns: ["id"];
          },
        ];
      };
      credit_balances: {
        Row: {
          balance: number;
          id: string;
          updated_at: string;
          version: number;
          workspace_id: string;
        };
        Insert: {
          balance?: number;
          id?: string;
          updated_at?: string;
          version?: number;
          workspace_id: string;
        };
        Update: {
          balance?: number;
          id?: string;
          updated_at?: string;
          version?: number;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "credit_balances_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: true;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      credit_transactions: {
        Row: {
          amount: number;
          balance_after: number;
          created_at: string;
          description: string | null;
          id: string;
          job_id: string | null;
          metadata: Json | null;
          transaction_type: Database["public"]["Enums"]["credit_transaction_type"];
          user_id: string | null;
          workspace_id: string;
        };
        Insert: {
          amount: number;
          balance_after: number;
          created_at?: string;
          description?: string | null;
          id?: string;
          job_id?: string | null;
          metadata?: Json | null;
          transaction_type: Database["public"]["Enums"]["credit_transaction_type"];
          user_id?: string | null;
          workspace_id: string;
        };
        Update: {
          amount?: number;
          balance_after?: number;
          created_at?: string;
          description?: string | null;
          id?: string;
          job_id?: string | null;
          metadata?: Json | null;
          transaction_type?: Database["public"]["Enums"]["credit_transaction_type"];
          user_id?: string | null;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "credit_transactions_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "background_jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "credit_transactions_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      daily_credit_claims: {
        Row: {
          amount: number;
          claim_date: string;
          created_at: string;
          id: string;
          workspace_id: string;
        };
        Insert: {
          amount: number;
          claim_date?: string;
          created_at?: string;
          id?: string;
          workspace_id: string;
        };
        Update: {
          amount?: number;
          claim_date?: string;
          created_at?: string;
          id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "daily_credit_claims_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      design_binding_reconcile_state: {
        Row: {
          cursor_canvas_id: string | null;
          cursor_updated_at: string | null;
          singleton: boolean;
          updated_at: string;
        };
        Insert: {
          cursor_canvas_id?: string | null;
          cursor_updated_at?: string | null;
          singleton?: boolean;
          updated_at?: string;
        };
        Update: {
          cursor_canvas_id?: string | null;
          cursor_updated_at?: string | null;
          singleton?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      design_agent_tool_requests: {
        Row: {
          actor_user_id: string;
          agent_run_id: string;
          completed_at: string | null;
          confirmation_id: string | null;
          created_at: string;
          design_id: string | null;
          destructive_confirmed: boolean;
          expected_revision: number | null;
          expected_template_revision: number | null;
          idempotency_key: string | null;
          input_hash: string;
          operation: string;
          result: Json | null;
          template_id: string | null;
          tool_execution_id: string;
          workspace_id: string;
        };
        Insert: {
          actor_user_id: string;
          agent_run_id: string;
          completed_at?: string | null;
          confirmation_id?: string | null;
          created_at?: string;
          design_id?: string | null;
          destructive_confirmed?: boolean;
          expected_revision?: number | null;
          expected_template_revision?: number | null;
          idempotency_key?: string | null;
          input_hash: string;
          operation: string;
          result?: Json | null;
          template_id?: string | null;
          tool_execution_id: string;
          workspace_id: string;
        };
        Update: {
          actor_user_id?: string;
          agent_run_id?: string;
          completed_at?: string | null;
          confirmation_id?: string | null;
          created_at?: string;
          design_id?: string | null;
          destructive_confirmed?: boolean;
          expected_revision?: number | null;
          expected_template_revision?: number | null;
          idempotency_key?: string | null;
          input_hash?: string;
          operation?: string;
          result?: Json | null;
          template_id?: string | null;
          tool_execution_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "design_agent_tool_requests_agent_run_id_fkey";
            columns: ["agent_run_id"];
            isOneToOne: false;
            referencedRelation: "agent_runs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "design_agent_tool_requests_design_id_fkey";
            columns: ["design_id"];
            isOneToOne: false;
            referencedRelation: "design_documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "design_agent_tool_requests_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "design_templates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "design_agent_tool_requests_tool_execution_id_fkey";
            columns: ["tool_execution_id"];
            isOneToOne: true;
            referencedRelation: "tool_executions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "design_agent_tool_requests_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      design_copy_requests: {
        Row: {
          actor_user_id: string;
          canvas_element_id: string;
          canvas_id: string;
          completed_at: string | null;
          created_at: string;
          id: string;
          request_id: string;
          request_payload: Json;
          response: Json | null;
          source_design_id: string;
          workspace_id: string;
        };
        Insert: {
          actor_user_id: string;
          canvas_element_id: string;
          canvas_id: string;
          completed_at?: string | null;
          created_at?: string;
          id?: string;
          request_id: string;
          request_payload: Json;
          response?: Json | null;
          source_design_id: string;
          workspace_id: string;
        };
        Update: {
          actor_user_id?: string;
          canvas_element_id?: string;
          canvas_id?: string;
          completed_at?: string | null;
          created_at?: string;
          id?: string;
          request_id?: string;
          request_payload?: Json;
          response?: Json | null;
          source_design_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "design_copy_requests_canvas_workspace_fkey";
            columns: ["canvas_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "canvases";
            referencedColumns: ["id", "workspace_id"];
          },
          {
            foreignKeyName: "design_copy_requests_source_workspace_fkey";
            columns: ["source_design_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "design_documents";
            referencedColumns: ["id", "workspace_id"];
          },
          {
            foreignKeyName: "design_copy_requests_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      design_creation_requests: {
        Row: {
          canvas_element_id: string;
          canvas_id: string;
          completed_at: string | null;
          created_at: string;
          created_by: string;
          design_id: string | null;
          error_code: string | null;
          id: string;
          request_id: string;
          response: Json | null;
          status: string;
          workspace_id: string;
        };
        Insert: {
          canvas_element_id: string;
          canvas_id: string;
          completed_at?: string | null;
          created_at?: string;
          created_by: string;
          design_id?: string | null;
          error_code?: string | null;
          id?: string;
          request_id: string;
          response?: Json | null;
          status?: string;
          workspace_id: string;
        };
        Update: {
          canvas_element_id?: string;
          canvas_id?: string;
          completed_at?: string | null;
          created_at?: string;
          created_by?: string;
          design_id?: string | null;
          error_code?: string | null;
          id?: string;
          request_id?: string;
          response?: Json | null;
          status?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "design_creation_requests_canvas_workspace_fkey";
            columns: ["canvas_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "canvases";
            referencedColumns: ["id", "workspace_id"];
          },
          {
            foreignKeyName: "design_creation_requests_design_id_fkey";
            columns: ["design_id"];
            isOneToOne: false;
            referencedRelation: "design_documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "design_creation_requests_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      design_document_asset_refs: {
        Row: {
          asset_object_id: string;
          created_at: string;
          design_id: string;
          object_id: string;
          resource_id: string | null;
          slot: string;
          workspace_id: string;
        };
        Insert: {
          asset_object_id: string;
          created_at?: string;
          design_id: string;
          object_id: string;
          resource_id?: string | null;
          slot?: string;
          workspace_id: string;
        };
        Update: {
          asset_object_id?: string;
          created_at?: string;
          design_id?: string;
          object_id?: string;
          resource_id?: string | null;
          slot?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "design_document_asset_refs_asset_object_id_fkey";
            columns: ["asset_object_id"];
            isOneToOne: false;
            referencedRelation: "asset_objects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "design_document_asset_refs_design_workspace_fkey";
            columns: ["design_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "design_documents";
            referencedColumns: ["id", "workspace_id"];
          },
          {
            foreignKeyName: "design_document_asset_refs_resource_fkey";
            columns: ["resource_id"];
            isOneToOne: false;
            referencedRelation: "design_resources";
            referencedColumns: ["id"];
          },
        ];
      };
      design_document_font_refs: {
        Row: {
          created_at: string;
          design_id: string;
          font_face_id: string;
          object_id: string;
          workspace_id: string;
        };
        Insert: {
          created_at?: string;
          design_id: string;
          font_face_id: string;
          object_id: string;
          workspace_id: string;
        };
        Update: {
          created_at?: string;
          design_id?: string;
          font_face_id?: string;
          object_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "design_document_font_refs_design_workspace_fkey";
            columns: ["design_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "design_documents";
            referencedColumns: ["id", "workspace_id"];
          },
          {
            foreignKeyName: "design_document_font_refs_font_face_fkey";
            columns: ["font_face_id"];
            isOneToOne: false;
            referencedRelation: "font_faces";
            referencedColumns: ["id"];
          },
        ];
      };
      design_document_versions: {
        Row: {
          actor_kind: string;
          actor_user_id: string | null;
          agent_run_id: string | null;
          changed_object_ids: string[];
          command_batch: Json;
          created_at: string;
          design_id: string;
          id: string;
          idempotency_key: string;
          parent_revision: number | null;
          revision: number;
          snapshot: Json | null;
          tool_execution_id: string | null;
          workspace_id: string;
        };
        Insert: {
          actor_kind: string;
          actor_user_id?: string | null;
          agent_run_id?: string | null;
          changed_object_ids?: string[];
          command_batch?: Json;
          created_at?: string;
          design_id: string;
          id?: string;
          idempotency_key: string;
          parent_revision?: number | null;
          revision: number;
          snapshot?: Json | null;
          tool_execution_id?: string | null;
          workspace_id: string;
        };
        Update: {
          actor_kind?: string;
          actor_user_id?: string | null;
          agent_run_id?: string | null;
          changed_object_ids?: string[];
          command_batch?: Json;
          created_at?: string;
          design_id?: string;
          id?: string;
          idempotency_key?: string;
          parent_revision?: number | null;
          revision?: number;
          snapshot?: Json | null;
          tool_execution_id?: string | null;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "design_document_versions_agent_run_id_fkey";
            columns: ["agent_run_id"];
            isOneToOne: false;
            referencedRelation: "agent_runs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "design_document_versions_design_workspace_fkey";
            columns: ["design_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "design_documents";
            referencedColumns: ["id", "workspace_id"];
          },
          {
            foreignKeyName: "design_document_versions_parent_fkey";
            columns: ["design_id", "parent_revision"];
            isOneToOne: false;
            referencedRelation: "design_document_versions";
            referencedColumns: ["design_id", "revision"];
          },
          {
            foreignKeyName: "design_document_versions_tool_execution_id_fkey";
            columns: ["tool_execution_id"];
            isOneToOne: false;
            referencedRelation: "tool_executions";
            referencedColumns: ["id"];
          },
        ];
      };
      design_documents: {
        Row: {
          created_at: string;
          created_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
          engine_version: string;
          height: number;
          id: string;
          name: string;
          preview_asset_object_id: string | null;
          preview_revision: number;
          preview_status: string;
          project_id: string;
          purge_after: string | null;
          revision: number;
          scene: Json;
          schema_version: number;
          updated_at: string;
          updated_by: string | null;
          width: number;
          workspace_id: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
          engine_version?: string;
          height: number;
          id?: string;
          name: string;
          preview_asset_object_id?: string | null;
          preview_revision?: number;
          preview_status?: string;
          project_id: string;
          purge_after?: string | null;
          revision?: number;
          scene: Json;
          schema_version?: number;
          updated_at?: string;
          updated_by?: string | null;
          width: number;
          workspace_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
          engine_version?: string;
          height?: number;
          id?: string;
          name?: string;
          preview_asset_object_id?: string | null;
          preview_revision?: number;
          preview_status?: string;
          project_id?: string;
          purge_after?: string | null;
          revision?: number;
          scene?: Json;
          schema_version?: number;
          updated_at?: string;
          updated_by?: string | null;
          width?: number;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "design_documents_preview_asset_object_id_fkey";
            columns: ["preview_asset_object_id"];
            isOneToOne: false;
            referencedRelation: "asset_objects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "design_documents_project_workspace_fkey";
            columns: ["project_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id", "workspace_id"];
          },
          {
            foreignKeyName: "design_documents_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      design_event_outbox: {
        Row: {
          attempt_count: number;
          available_at: string;
          claim_token: string | null;
          claimed_at: string | null;
          created_at: string;
          design_id: string;
          event_type: string;
          id: string;
          last_error: string | null;
          payload: Json;
          published_at: string | null;
          revision: number;
          status: string;
          workspace_id: string;
        };
        Insert: {
          attempt_count?: number;
          available_at?: string;
          claim_token?: string | null;
          claimed_at?: string | null;
          created_at?: string;
          design_id: string;
          event_type?: string;
          id?: string;
          last_error?: string | null;
          payload: Json;
          published_at?: string | null;
          revision: number;
          status?: string;
          workspace_id: string;
        };
        Update: {
          attempt_count?: number;
          available_at?: string;
          claim_token?: string | null;
          claimed_at?: string | null;
          created_at?: string;
          design_id?: string;
          event_type?: string;
          id?: string;
          last_error?: string | null;
          payload?: Json;
          published_at?: string | null;
          revision?: number;
          status?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "design_event_outbox_design_workspace_fkey";
            columns: ["design_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "design_documents";
            referencedColumns: ["id", "workspace_id"];
          },
        ];
      };
      design_lifecycle_requests: {
        Row: {
          actor_user_id: string;
          completed_at: string | null;
          created_at: string;
          design_id: string;
          id: string;
          idempotency_key: string;
          operation: string;
          request_payload: Json;
          response: Json | null;
          workspace_id: string;
        };
        Insert: {
          actor_user_id: string;
          completed_at?: string | null;
          created_at?: string;
          design_id: string;
          id?: string;
          idempotency_key: string;
          operation: string;
          request_payload: Json;
          response?: Json | null;
          workspace_id: string;
        };
        Update: {
          actor_user_id?: string;
          completed_at?: string | null;
          created_at?: string;
          design_id?: string;
          id?: string;
          idempotency_key?: string;
          operation?: string;
          request_payload?: Json;
          response?: Json | null;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "design_lifecycle_requests_design_workspace_fkey";
            columns: ["design_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "design_documents";
            referencedColumns: ["id", "workspace_id"];
          },
        ];
      };
      design_nodes: {
        Row: {
          canvas_id: string;
          created_at: string;
          created_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
          design_id: string;
          element_id: string;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          canvas_id: string;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
          design_id: string;
          element_id: string;
          updated_at?: string;
          workspace_id: string;
        };
        Update: {
          canvas_id?: string;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
          design_id?: string;
          element_id?: string;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "design_nodes_canvas_workspace_fkey";
            columns: ["canvas_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "canvases";
            referencedColumns: ["id", "workspace_id"];
          },
          {
            foreignKeyName: "design_nodes_design_workspace_fkey";
            columns: ["design_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "design_documents";
            referencedColumns: ["id", "workspace_id"];
          },
        ];
      };
      design_preview_requests: {
        Row: {
          actor_user_id: string | null;
          completed_at: string | null;
          created_at: string;
          design_id: string;
          expected_revision: number;
          id: string;
          idempotency_key: string;
          job_id: string | null;
          operation: string;
          preview_asset_object_id: string | null;
          response: Json | null;
          workspace_id: string;
        };
        Insert: {
          actor_user_id?: string | null;
          completed_at?: string | null;
          created_at?: string;
          design_id: string;
          expected_revision: number;
          id?: string;
          idempotency_key: string;
          job_id?: string | null;
          operation: string;
          preview_asset_object_id?: string | null;
          response?: Json | null;
          workspace_id: string;
        };
        Update: {
          actor_user_id?: string | null;
          completed_at?: string | null;
          created_at?: string;
          design_id?: string;
          expected_revision?: number;
          id?: string;
          idempotency_key?: string;
          job_id?: string | null;
          operation?: string;
          preview_asset_object_id?: string | null;
          response?: Json | null;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "design_preview_requests_design_workspace_fkey";
            columns: ["design_id", "workspace_id"];
            isOneToOne: false;
            referencedRelation: "design_documents";
            referencedColumns: ["id", "workspace_id"];
          },
          {
            foreignKeyName: "design_preview_requests_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "background_jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "design_preview_requests_preview_asset_object_id_fkey";
            columns: ["preview_asset_object_id"];
            isOneToOne: false;
            referencedRelation: "asset_objects";
            referencedColumns: ["id"];
          },
        ];
      };
      design_resources: {
        Row: {
          asset_object_id: string;
          attribution: string | null;
          author: string | null;
          category_id: string | null;
          checksum_sha256: string | null;
          created_at: string;
          created_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
          description: string | null;
          height: number | null;
          id: string;
          kind: string;
          license_name: string | null;
          license_url: string | null;
          name: string;
          preview_asset_object_id: string | null;
          published_at: string | null;
          published_by: string | null;
          revision: number;
          scope: string;
          source_url: string | null;
          status: string;
          updated_at: string;
          updated_by: string | null;
          usage_restrictions: string | null;
          width: number | null;
          workspace_id: string | null;
        };
        Insert: {
          asset_object_id: string;
          attribution?: string | null;
          author?: string | null;
          category_id?: string | null;
          checksum_sha256?: string | null;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
          description?: string | null;
          height?: number | null;
          id?: string;
          kind: string;
          license_name?: string | null;
          license_url?: string | null;
          name: string;
          preview_asset_object_id?: string | null;
          published_at?: string | null;
          published_by?: string | null;
          revision?: number;
          scope: string;
          source_url?: string | null;
          status?: string;
          updated_at?: string;
          updated_by?: string | null;
          usage_restrictions?: string | null;
          width?: number | null;
          workspace_id?: string | null;
        };
        Update: {
          asset_object_id?: string;
          attribution?: string | null;
          author?: string | null;
          category_id?: string | null;
          checksum_sha256?: string | null;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
          description?: string | null;
          height?: number | null;
          id?: string;
          kind?: string;
          license_name?: string | null;
          license_url?: string | null;
          name?: string;
          preview_asset_object_id?: string | null;
          published_at?: string | null;
          published_by?: string | null;
          revision?: number;
          scope?: string;
          source_url?: string | null;
          status?: string;
          updated_at?: string;
          updated_by?: string | null;
          usage_restrictions?: string | null;
          width?: number | null;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "design_resources_asset_object_id_fkey";
            columns: ["asset_object_id"];
            isOneToOne: false;
            referencedRelation: "asset_objects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "design_resources_category_id_fkey";
            columns: ["category_id"];
            isOneToOne: false;
            referencedRelation: "resource_categories";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "design_resources_preview_asset_object_id_fkey";
            columns: ["preview_asset_object_id"];
            isOneToOne: false;
            referencedRelation: "asset_objects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "design_resources_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      design_template_asset_refs: {
        Row: {
          asset_object_id: string;
          created_at: string;
          object_id: string;
          resource_id: string | null;
          slot: string;
          template_id: string;
        };
        Insert: {
          asset_object_id: string;
          created_at?: string;
          object_id: string;
          resource_id?: string | null;
          slot?: string;
          template_id: string;
        };
        Update: {
          asset_object_id?: string;
          created_at?: string;
          object_id?: string;
          resource_id?: string | null;
          slot?: string;
          template_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "design_template_asset_refs_asset_object_id_fkey";
            columns: ["asset_object_id"];
            isOneToOne: false;
            referencedRelation: "asset_objects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "design_template_asset_refs_resource_id_fkey";
            columns: ["resource_id"];
            isOneToOne: false;
            referencedRelation: "design_resources";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "design_template_asset_refs_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "design_templates";
            referencedColumns: ["id"];
          },
        ];
      };
      design_template_font_refs: {
        Row: {
          created_at: string;
          font_face_id: string;
          object_id: string;
          template_id: string;
        };
        Insert: {
          created_at?: string;
          font_face_id: string;
          object_id: string;
          template_id: string;
        };
        Update: {
          created_at?: string;
          font_face_id?: string;
          object_id?: string;
          template_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "design_template_font_refs_font_face_id_fkey";
            columns: ["font_face_id"];
            isOneToOne: false;
            referencedRelation: "font_faces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "design_template_font_refs_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "design_templates";
            referencedColumns: ["id"];
          },
        ];
      };
      design_template_tag_links: {
        Row: {
          created_at: string;
          tag_id: string;
          template_id: string;
        };
        Insert: {
          created_at?: string;
          tag_id: string;
          template_id: string;
        };
        Update: {
          created_at?: string;
          tag_id?: string;
          template_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "design_template_tag_links_tag_id_fkey";
            columns: ["tag_id"];
            isOneToOne: false;
            referencedRelation: "resource_tags";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "design_template_tag_links_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "design_templates";
            referencedColumns: ["id"];
          },
        ];
      };
      design_templates: {
        Row: {
          attribution: string | null;
          author: string | null;
          category_id: string | null;
          created_at: string;
          created_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
          description: string | null;
          engine_version: string;
          height: number;
          id: string;
          license_name: string | null;
          license_url: string | null;
          name: string;
          preview_asset_object_id: string | null;
          published_at: string | null;
          published_by: string | null;
          revision: number;
          scene: Json;
          schema_version: number;
          scope: string;
          source_url: string | null;
          status: string;
          updated_at: string;
          updated_by: string | null;
          usage_restrictions: string | null;
          variables: Json;
          width: number;
          workspace_id: string | null;
        };
        Insert: {
          attribution?: string | null;
          author?: string | null;
          category_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
          description?: string | null;
          engine_version?: string;
          height: number;
          id?: string;
          license_name?: string | null;
          license_url?: string | null;
          name: string;
          preview_asset_object_id?: string | null;
          published_at?: string | null;
          published_by?: string | null;
          revision?: number;
          scene: Json;
          schema_version?: number;
          scope: string;
          source_url?: string | null;
          status?: string;
          updated_at?: string;
          updated_by?: string | null;
          usage_restrictions?: string | null;
          variables?: Json;
          width: number;
          workspace_id?: string | null;
        };
        Update: {
          attribution?: string | null;
          author?: string | null;
          category_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
          description?: string | null;
          engine_version?: string;
          height?: number;
          id?: string;
          license_name?: string | null;
          license_url?: string | null;
          name?: string;
          preview_asset_object_id?: string | null;
          published_at?: string | null;
          published_by?: string | null;
          revision?: number;
          scene?: Json;
          schema_version?: number;
          scope?: string;
          source_url?: string | null;
          status?: string;
          updated_at?: string;
          updated_by?: string | null;
          usage_restrictions?: string | null;
          variables?: Json;
          width?: number;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "design_templates_category_id_fkey";
            columns: ["category_id"];
            isOneToOne: false;
            referencedRelation: "resource_categories";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "design_templates_preview_asset_object_id_fkey";
            columns: ["preview_asset_object_id"];
            isOneToOne: false;
            referencedRelation: "asset_objects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "design_templates_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      font_faces: {
        Row: {
          allow_web_embed: boolean;
          asset_object_id: string;
          checksum_sha256: string | null;
          created_at: string;
          created_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
          family_id: string;
          format: string;
          id: string;
          published_at: string | null;
          published_by: string | null;
          revision: number;
          scope: string;
          status: string;
          style: string;
          updated_at: string;
          updated_by: string | null;
          weight: number;
          workspace_id: string | null;
        };
        Insert: {
          allow_web_embed?: boolean;
          asset_object_id: string;
          checksum_sha256?: string | null;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
          family_id: string;
          format: string;
          id?: string;
          published_at?: string | null;
          published_by?: string | null;
          revision?: number;
          scope: string;
          status?: string;
          style?: string;
          updated_at?: string;
          updated_by?: string | null;
          weight?: number;
          workspace_id?: string | null;
        };
        Update: {
          allow_web_embed?: boolean;
          asset_object_id?: string;
          checksum_sha256?: string | null;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
          family_id?: string;
          format?: string;
          id?: string;
          published_at?: string | null;
          published_by?: string | null;
          revision?: number;
          scope?: string;
          status?: string;
          style?: string;
          updated_at?: string;
          updated_by?: string | null;
          weight?: number;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "font_faces_asset_object_id_fkey";
            columns: ["asset_object_id"];
            isOneToOne: false;
            referencedRelation: "asset_objects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "font_faces_family_id_fkey";
            columns: ["family_id"];
            isOneToOne: false;
            referencedRelation: "font_families";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "font_faces_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      font_families: {
        Row: {
          attribution: string | null;
          author: string | null;
          created_at: string;
          created_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
          id: string;
          license_name: string | null;
          license_url: string | null;
          name: string;
          published_at: string | null;
          published_by: string | null;
          revision: number;
          scope: string;
          source_url: string | null;
          status: string;
          updated_at: string;
          updated_by: string | null;
          usage_restrictions: string | null;
          workspace_id: string | null;
        };
        Insert: {
          attribution?: string | null;
          author?: string | null;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
          id?: string;
          license_name?: string | null;
          license_url?: string | null;
          name: string;
          published_at?: string | null;
          published_by?: string | null;
          revision?: number;
          scope: string;
          source_url?: string | null;
          status?: string;
          updated_at?: string;
          updated_by?: string | null;
          usage_restrictions?: string | null;
          workspace_id?: string | null;
        };
        Update: {
          attribution?: string | null;
          author?: string | null;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
          id?: string;
          license_name?: string | null;
          license_url?: string | null;
          name?: string;
          published_at?: string | null;
          published_by?: string | null;
          revision?: number;
          scope?: string;
          source_url?: string | null;
          status?: string;
          updated_at?: string;
          updated_by?: string | null;
          usage_restrictions?: string | null;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "font_families_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      home_discovery_cases: {
        Row: {
          author_avatar_url: string;
          author_name: string;
          case_url: string;
          category_key: string;
          cover_image_url: string;
          created_at: string;
          id: string;
          is_active: boolean;
          like_count: number;
          seed_prompt: string;
          sort_order: number;
          title: string;
          updated_at: string;
          view_count: number;
        };
        Insert: {
          author_avatar_url: string;
          author_name: string;
          case_url: string;
          category_key: string;
          cover_image_url: string;
          created_at?: string;
          id: string;
          is_active?: boolean;
          like_count?: number;
          seed_prompt?: string;
          sort_order?: number;
          title: string;
          updated_at?: string;
          view_count?: number;
        };
        Update: {
          author_avatar_url?: string;
          author_name?: string;
          case_url?: string;
          category_key?: string;
          cover_image_url?: string;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          like_count?: number;
          seed_prompt?: string;
          sort_order?: number;
          title?: string;
          updated_at?: string;
          view_count?: number;
        };
        Relationships: [
          {
            foreignKeyName: "home_discovery_cases_category_key_fkey";
            columns: ["category_key"];
            isOneToOne: false;
            referencedRelation: "home_discovery_categories";
            referencedColumns: ["key"];
          },
        ];
      };
      home_discovery_categories: {
        Row: {
          created_at: string;
          is_active: boolean;
          key: string;
          label: string;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          is_active?: boolean;
          key: string;
          label: string;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          is_active?: boolean;
          key?: string;
          label?: string;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      home_example_categories: {
        Row: {
          accent: string | null;
          created_at: string;
          data_type: string;
          is_active: boolean;
          key: string;
          label: string;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          accent?: string | null;
          created_at?: string;
          data_type: string;
          is_active?: boolean;
          key: string;
          label: string;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          accent?: string | null;
          created_at?: string;
          data_type?: string;
          is_active?: boolean;
          key?: string;
          label?: string;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      home_example_examples: {
        Row: {
          category_key: string;
          created_at: string;
          id: string;
          image_urls: string[];
          input_mentions: Json;
          is_active: boolean;
          prompt: string;
          sort_order: number;
          title: string;
          updated_at: string;
        };
        Insert: {
          category_key: string;
          created_at?: string;
          id?: string;
          image_urls?: string[];
          input_mentions?: Json;
          is_active?: boolean;
          prompt: string;
          sort_order?: number;
          title: string;
          updated_at?: string;
        };
        Update: {
          category_key?: string;
          created_at?: string;
          id?: string;
          image_urls?: string[];
          input_mentions?: Json;
          is_active?: boolean;
          prompt?: string;
          sort_order?: number;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "home_example_examples_category_key_fkey";
            columns: ["category_key"];
            isOneToOne: false;
            referencedRelation: "home_example_categories";
            referencedColumns: ["key"];
          },
        ];
      };
      job_target_finalizations: {
        Row: {
          attempt_count: number;
          command_id: string;
          completed_at: string | null;
          created_at: string;
          error_code: string | null;
          error_message: string | null;
          id: string;
          job_id: string;
          result: Json | null;
          status: string;
          target_id: string;
          target_kind: string;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          attempt_count?: number;
          command_id: string;
          completed_at?: string | null;
          created_at?: string;
          error_code?: string | null;
          error_message?: string | null;
          id?: string;
          job_id: string;
          result?: Json | null;
          status?: string;
          target_id: string;
          target_kind: string;
          updated_at?: string;
          workspace_id: string;
        };
        Update: {
          attempt_count?: number;
          command_id?: string;
          completed_at?: string | null;
          created_at?: string;
          error_code?: string | null;
          error_message?: string | null;
          id?: string;
          job_id?: string;
          result?: Json | null;
          status?: string;
          target_id?: string;
          target_kind?: string;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "job_target_finalizations_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "background_jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_target_finalizations_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      payment_events: {
        Row: {
          created_at: string;
          delivery_fingerprint: string | null;
          error_message: string | null;
          event_name: string;
          id: string;
          lemon_squeezy_event_id: string | null;
          payload: Json;
          processed: boolean;
          workspace_id: string | null;
        };
        Insert: {
          created_at?: string;
          delivery_fingerprint?: string | null;
          error_message?: string | null;
          event_name: string;
          id?: string;
          lemon_squeezy_event_id?: string | null;
          payload?: Json;
          processed?: boolean;
          workspace_id?: string | null;
        };
        Update: {
          created_at?: string;
          delivery_fingerprint?: string | null;
          error_message?: string | null;
          event_name?: string;
          id?: string;
          lemon_squeezy_event_id?: string | null;
          payload?: Json;
          processed?: boolean;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "payment_events_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      platform_admins: {
        Row: {
          granted_at: string;
          granted_by: string | null;
          is_active: boolean;
          revoked_at: string | null;
          user_id: string;
        };
        Insert: {
          granted_at?: string;
          granted_by?: string | null;
          is_active?: boolean;
          revoked_at?: string | null;
          user_id: string;
        };
        Update: {
          granted_at?: string;
          granted_by?: string | null;
          is_active?: boolean;
          revoked_at?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          created_at: string;
          display_name: string | null;
          email: string | null;
          id: string;
          updated_at: string;
        };
        Insert: {
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string | null;
          email?: string | null;
          id: string;
          updated_at?: string;
        };
        Update: {
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string | null;
          email?: string | null;
          id?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      projects: {
        Row: {
          archived_at: string | null;
          brand_kit_id: string | null;
          created_at: string;
          created_by: string | null;
          description: string | null;
          id: string;
          name: string;
          slug: string;
          thumbnail_path: string | null;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          archived_at?: string | null;
          brand_kit_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          name: string;
          slug: string;
          thumbnail_path?: string | null;
          updated_at?: string;
          workspace_id: string;
        };
        Update: {
          archived_at?: string | null;
          brand_kit_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          name?: string;
          slug?: string;
          thumbnail_path?: string | null;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "projects_brand_kit_id_fkey";
            columns: ["brand_kit_id"];
            isOneToOne: false;
            referencedRelation: "brand_kits";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "projects_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      provider_execution_credentials: {
        Row: {
          api_key_secret_id: string;
          created_at: string;
          snapshot_id: string;
        };
        Insert: {
          api_key_secret_id: string;
          created_at?: string;
          snapshot_id: string;
        };
        Update: {
          api_key_secret_id?: string;
          created_at?: string;
          snapshot_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "provider_execution_credentials_snapshot_id_fkey";
            columns: ["snapshot_id"];
            isOneToOne: true;
            referencedRelation: "provider_execution_snapshots";
            referencedColumns: ["id"];
          },
        ];
      };
      provider_execution_snapshots: {
        Row: {
          adapter: string;
          agent_run_id: string | null;
          background_job_id: string | null;
          base_url: string;
          billing_credits_cost: number | null;
          billing_pricing_version: string | null;
          billing_unit: string | null;
          capabilities: Json;
          catalog_key: string;
          created_at: string;
          id: string;
          modality: string;
          provider_config_id: string;
          provider_revision: number;
          upstream_model_id: string;
          workspace_id: string;
        };
        Insert: {
          adapter: string;
          agent_run_id?: string | null;
          background_job_id?: string | null;
          base_url: string;
          billing_credits_cost?: number | null;
          billing_pricing_version?: string | null;
          billing_unit?: string | null;
          capabilities: Json;
          catalog_key: string;
          created_at?: string;
          id?: string;
          modality: string;
          provider_config_id: string;
          provider_revision: number;
          upstream_model_id: string;
          workspace_id: string;
        };
        Update: {
          adapter?: string;
          agent_run_id?: string | null;
          background_job_id?: string | null;
          base_url?: string;
          billing_credits_cost?: number | null;
          billing_pricing_version?: string | null;
          billing_unit?: string | null;
          capabilities?: Json;
          catalog_key?: string;
          created_at?: string;
          id?: string;
          modality?: string;
          provider_config_id?: string;
          provider_revision?: number;
          upstream_model_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "provider_execution_snapshots_agent_run_id_fkey";
            columns: ["agent_run_id"];
            isOneToOne: false;
            referencedRelation: "agent_runs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "provider_execution_snapshots_background_job_id_fkey";
            columns: ["background_job_id"];
            isOneToOne: false;
            referencedRelation: "background_jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "provider_execution_snapshots_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      resource_categories: {
        Row: {
          created_at: string;
          created_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
          id: string;
          name: string;
          parent_id: string | null;
          published_at: string | null;
          published_by: string | null;
          revision: number;
          scope: string;
          slug: string;
          sort_order: number;
          status: string;
          updated_at: string;
          updated_by: string | null;
          workspace_id: string | null;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
          id?: string;
          name: string;
          parent_id?: string | null;
          published_at?: string | null;
          published_by?: string | null;
          revision?: number;
          scope: string;
          slug: string;
          sort_order?: number;
          status?: string;
          updated_at?: string;
          updated_by?: string | null;
          workspace_id?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
          id?: string;
          name?: string;
          parent_id?: string | null;
          published_at?: string | null;
          published_by?: string | null;
          revision?: number;
          scope?: string;
          slug?: string;
          sort_order?: number;
          status?: string;
          updated_at?: string;
          updated_by?: string | null;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "resource_categories_parent_id_fkey";
            columns: ["parent_id"];
            isOneToOne: false;
            referencedRelation: "resource_categories";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "resource_categories_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      resource_favorites: {
        Row: {
          created_at: string;
          resource_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          resource_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          resource_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "resource_favorites_resource_id_fkey";
            columns: ["resource_id"];
            isOneToOne: false;
            referencedRelation: "design_resources";
            referencedColumns: ["id"];
          },
        ];
      };
      resource_import_items: {
        Row: {
          asset_object_id: string | null;
          attempt_count: number;
          claim_token: string | null;
          completed_at: string | null;
          created_at: string;
          error_code: string | null;
          error_message: string | null;
          id: string;
          import_job_id: string;
          metadata: Json;
          resource_id: string | null;
          result_entity_id: string | null;
          result_entity_kind: string | null;
          source_key: string;
          status: string;
        };
        Insert: {
          asset_object_id?: string | null;
          attempt_count?: number;
          claim_token?: string | null;
          completed_at?: string | null;
          created_at?: string;
          error_code?: string | null;
          error_message?: string | null;
          id?: string;
          import_job_id: string;
          metadata?: Json;
          resource_id?: string | null;
          result_entity_id?: string | null;
          result_entity_kind?: string | null;
          source_key: string;
          status?: string;
        };
        Update: {
          asset_object_id?: string | null;
          attempt_count?: number;
          claim_token?: string | null;
          completed_at?: string | null;
          created_at?: string;
          error_code?: string | null;
          error_message?: string | null;
          id?: string;
          import_job_id?: string;
          metadata?: Json;
          resource_id?: string | null;
          result_entity_id?: string | null;
          result_entity_kind?: string | null;
          source_key?: string;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "resource_import_items_asset_object_id_fkey";
            columns: ["asset_object_id"];
            isOneToOne: false;
            referencedRelation: "asset_objects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "resource_import_items_import_job_id_fkey";
            columns: ["import_job_id"];
            isOneToOne: false;
            referencedRelation: "resource_import_jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "resource_import_items_resource_id_fkey";
            columns: ["resource_id"];
            isOneToOne: false;
            referencedRelation: "design_resources";
            referencedColumns: ["id"];
          },
        ];
      };
      resource_import_jobs: {
        Row: {
          attempt_count: number;
          available_at: string;
          background_job_id: string | null;
          claim_token: string | null;
          claimed_at: string | null;
          completed_at: string | null;
          completed_items: number;
          created_at: string;
          created_by: string | null;
          failed_items: number;
          id: string;
          input_hash: string | null;
          last_error: string | null;
          request_id: string | null;
          scope: string;
          source: Json;
          source_kind: string;
          started_at: string | null;
          status: string;
          total_items: number;
          workspace_id: string | null;
        };
        Insert: {
          attempt_count?: number;
          available_at?: string;
          background_job_id?: string | null;
          claim_token?: string | null;
          claimed_at?: string | null;
          completed_at?: string | null;
          completed_items?: number;
          created_at?: string;
          created_by?: string | null;
          failed_items?: number;
          id?: string;
          input_hash?: string | null;
          last_error?: string | null;
          request_id?: string | null;
          scope: string;
          source?: Json;
          source_kind: string;
          started_at?: string | null;
          status?: string;
          total_items?: number;
          workspace_id?: string | null;
        };
        Update: {
          attempt_count?: number;
          available_at?: string;
          background_job_id?: string | null;
          claim_token?: string | null;
          claimed_at?: string | null;
          completed_at?: string | null;
          completed_items?: number;
          created_at?: string;
          created_by?: string | null;
          failed_items?: number;
          id?: string;
          input_hash?: string | null;
          last_error?: string | null;
          request_id?: string | null;
          scope?: string;
          source?: Json;
          source_kind?: string;
          started_at?: string | null;
          status?: string;
          total_items?: number;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "resource_import_jobs_background_job_id_fkey";
            columns: ["background_job_id"];
            isOneToOne: false;
            referencedRelation: "background_jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "resource_import_jobs_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      resource_recent_uses: {
        Row: {
          resource_id: string;
          use_count: number;
          used_at: string;
          user_id: string;
          workspace_id: string;
        };
        Insert: {
          resource_id: string;
          use_count?: number;
          used_at?: string;
          user_id: string;
          workspace_id: string;
        };
        Update: {
          resource_id?: string;
          use_count?: number;
          used_at?: string;
          user_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "resource_recent_uses_resource_id_fkey";
            columns: ["resource_id"];
            isOneToOne: false;
            referencedRelation: "design_resources";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "resource_recent_uses_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      resource_tag_links: {
        Row: {
          created_at: string;
          resource_id: string;
          tag_id: string;
        };
        Insert: {
          created_at?: string;
          resource_id: string;
          tag_id: string;
        };
        Update: {
          created_at?: string;
          resource_id?: string;
          tag_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "resource_tag_links_resource_id_fkey";
            columns: ["resource_id"];
            isOneToOne: false;
            referencedRelation: "design_resources";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "resource_tag_links_tag_id_fkey";
            columns: ["tag_id"];
            isOneToOne: false;
            referencedRelation: "resource_tags";
            referencedColumns: ["id"];
          },
        ];
      };
      resource_tags: {
        Row: {
          created_at: string;
          created_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
          id: string;
          name: string;
          published_at: string | null;
          published_by: string | null;
          revision: number;
          scope: string;
          slug: string;
          status: string;
          updated_at: string;
          updated_by: string | null;
          workspace_id: string | null;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
          id?: string;
          name: string;
          published_at?: string | null;
          published_by?: string | null;
          revision?: number;
          scope: string;
          slug: string;
          status?: string;
          updated_at?: string;
          updated_by?: string | null;
          workspace_id?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
          id?: string;
          name?: string;
          published_at?: string | null;
          published_by?: string | null;
          revision?: number;
          scope?: string;
          slug?: string;
          status?: string;
          updated_at?: string;
          updated_by?: string | null;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "resource_tags_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      skill_files: {
        Row: {
          content: string;
          created_at: string;
          file_path: string;
          id: string;
          mime_type: string;
          skill_id: string;
          updated_at: string;
        };
        Insert: {
          content: string;
          created_at?: string;
          file_path: string;
          id?: string;
          mime_type?: string;
          skill_id: string;
          updated_at?: string;
        };
        Update: {
          content?: string;
          created_at?: string;
          file_path?: string;
          id?: string;
          mime_type?: string;
          skill_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "skill_files_skill_id_fkey";
            columns: ["skill_id"];
            isOneToOne: false;
            referencedRelation: "skills";
            referencedColumns: ["id"];
          },
        ];
      };
      skills: {
        Row: {
          author: string;
          category: string;
          created_at: string;
          created_by: string | null;
          description: string;
          icon_name: string | null;
          id: string;
          is_featured: boolean;
          license: string | null;
          metadata: Json | null;
          name: string;
          package_name: string | null;
          skill_content: string;
          slug: string;
          source: string;
          source_url: string | null;
          updated_at: string;
          version: string;
        };
        Insert: {
          author?: string;
          category?: string;
          created_at?: string;
          created_by?: string | null;
          description?: string;
          icon_name?: string | null;
          id?: string;
          is_featured?: boolean;
          license?: string | null;
          metadata?: Json | null;
          name: string;
          package_name?: string | null;
          skill_content: string;
          slug: string;
          source?: string;
          source_url?: string | null;
          updated_at?: string;
          version?: string;
        };
        Update: {
          author?: string;
          category?: string;
          created_at?: string;
          created_by?: string | null;
          description?: string;
          icon_name?: string | null;
          id?: string;
          is_featured?: boolean;
          license?: string | null;
          metadata?: Json | null;
          name?: string;
          package_name?: string | null;
          skill_content?: string;
          slug?: string;
          source?: string;
          source_url?: string | null;
          updated_at?: string;
          version?: string;
        };
        Relationships: [];
      };
      subscriptions: {
        Row: {
          billing_period: Database["public"]["Enums"]["billing_period"] | null;
          canceled_at: string | null;
          created_at: string;
          current_period_end: string | null;
          current_period_start: string | null;
          id: string;
          lemon_squeezy_customer_id: string | null;
          lemon_squeezy_order_id: string | null;
          lemon_squeezy_subscription_id: string | null;
          lemon_squeezy_variant_id: string | null;
          plan: Database["public"]["Enums"]["subscription_plan"];
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          billing_period?: Database["public"]["Enums"]["billing_period"] | null;
          canceled_at?: string | null;
          created_at?: string;
          current_period_end?: string | null;
          current_period_start?: string | null;
          id?: string;
          lemon_squeezy_customer_id?: string | null;
          lemon_squeezy_order_id?: string | null;
          lemon_squeezy_subscription_id?: string | null;
          lemon_squeezy_variant_id?: string | null;
          plan?: Database["public"]["Enums"]["subscription_plan"];
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          updated_at?: string;
          workspace_id: string;
        };
        Update: {
          billing_period?: Database["public"]["Enums"]["billing_period"] | null;
          canceled_at?: string | null;
          created_at?: string;
          current_period_end?: string | null;
          current_period_start?: string | null;
          id?: string;
          lemon_squeezy_customer_id?: string | null;
          lemon_squeezy_order_id?: string | null;
          lemon_squeezy_subscription_id?: string | null;
          lemon_squeezy_variant_id?: string | null;
          plan?: Database["public"]["Enums"]["subscription_plan"];
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "subscriptions_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: true;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      text_preset_font_refs: {
        Row: {
          created_at: string;
          font_face_id: string;
          object_id: string;
          text_preset_id: string;
        };
        Insert: {
          created_at?: string;
          font_face_id: string;
          object_id: string;
          text_preset_id: string;
        };
        Update: {
          created_at?: string;
          font_face_id?: string;
          object_id?: string;
          text_preset_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "text_preset_font_refs_font_face_id_fkey";
            columns: ["font_face_id"];
            isOneToOne: false;
            referencedRelation: "font_faces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "text_preset_font_refs_text_preset_id_fkey";
            columns: ["text_preset_id"];
            isOneToOne: false;
            referencedRelation: "text_presets";
            referencedColumns: ["id"];
          },
        ];
      };
      text_preset_tag_links: {
        Row: {
          created_at: string;
          tag_id: string;
          text_preset_id: string;
        };
        Insert: {
          created_at?: string;
          tag_id: string;
          text_preset_id: string;
        };
        Update: {
          created_at?: string;
          tag_id?: string;
          text_preset_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "text_preset_tag_links_tag_id_fkey";
            columns: ["tag_id"];
            isOneToOne: false;
            referencedRelation: "resource_tags";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "text_preset_tag_links_text_preset_id_fkey";
            columns: ["text_preset_id"];
            isOneToOne: false;
            referencedRelation: "text_presets";
            referencedColumns: ["id"];
          },
        ];
      };
      text_presets: {
        Row: {
          attribution: string | null;
          author: string | null;
          category_id: string | null;
          created_at: string;
          created_by: string | null;
          deleted_at: string | null;
          deleted_by: string | null;
          font_face_id: string | null;
          id: string;
          license_name: string | null;
          license_url: string | null;
          name: string;
          preview_asset_object_id: string | null;
          published_at: string | null;
          published_by: string | null;
          revision: number;
          scope: string;
          source_url: string | null;
          status: string;
          style: Json;
          updated_at: string;
          updated_by: string | null;
          usage_restrictions: string | null;
          workspace_id: string | null;
        };
        Insert: {
          attribution?: string | null;
          author?: string | null;
          category_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
          font_face_id?: string | null;
          id?: string;
          license_name?: string | null;
          license_url?: string | null;
          name: string;
          preview_asset_object_id?: string | null;
          published_at?: string | null;
          published_by?: string | null;
          revision?: number;
          scope: string;
          source_url?: string | null;
          status?: string;
          style?: Json;
          updated_at?: string;
          updated_by?: string | null;
          usage_restrictions?: string | null;
          workspace_id?: string | null;
        };
        Update: {
          attribution?: string | null;
          author?: string | null;
          category_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          deleted_at?: string | null;
          deleted_by?: string | null;
          font_face_id?: string | null;
          id?: string;
          license_name?: string | null;
          license_url?: string | null;
          name?: string;
          preview_asset_object_id?: string | null;
          published_at?: string | null;
          published_by?: string | null;
          revision?: number;
          scope?: string;
          source_url?: string | null;
          status?: string;
          style?: Json;
          updated_at?: string;
          updated_by?: string | null;
          usage_restrictions?: string | null;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "text_presets_category_id_fkey";
            columns: ["category_id"];
            isOneToOne: false;
            referencedRelation: "resource_categories";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "text_presets_font_face_id_fkey";
            columns: ["font_face_id"];
            isOneToOne: false;
            referencedRelation: "font_faces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "text_presets_preview_asset_object_id_fkey";
            columns: ["preview_asset_object_id"];
            isOneToOne: false;
            referencedRelation: "asset_objects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "text_presets_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      tool_executions: {
        Row: {
          artifacts: Json | null;
          attempt: number;
          created_at: string;
          error_code: string | null;
          error_message: string | null;
          finished_at: string | null;
          id: string;
          input: Json | null;
          output: Json | null;
          output_summary: string | null;
          plan_id: string | null;
          plan_step_id: string | null;
          requested_by: string | null;
          retry_of: string | null;
          retry_request_id: string | null;
          retryable: boolean;
          run_id: string;
          started_at: string;
          status: string;
          tool_call_id: string;
          tool_name: string;
          updated_at: string;
        };
        Insert: {
          artifacts?: Json | null;
          attempt?: number;
          created_at?: string;
          error_code?: string | null;
          error_message?: string | null;
          finished_at?: string | null;
          id?: string;
          input?: Json | null;
          output?: Json | null;
          output_summary?: string | null;
          plan_id?: string | null;
          plan_step_id?: string | null;
          requested_by?: string | null;
          retry_of?: string | null;
          retry_request_id?: string | null;
          retryable?: boolean;
          run_id: string;
          started_at?: string;
          status: string;
          tool_call_id: string;
          tool_name: string;
          updated_at?: string;
        };
        Update: {
          artifacts?: Json | null;
          attempt?: number;
          created_at?: string;
          error_code?: string | null;
          error_message?: string | null;
          finished_at?: string | null;
          id?: string;
          input?: Json | null;
          output?: Json | null;
          output_summary?: string | null;
          plan_id?: string | null;
          plan_step_id?: string | null;
          requested_by?: string | null;
          retry_of?: string | null;
          retry_request_id?: string | null;
          retryable?: boolean;
          run_id?: string;
          started_at?: string;
          status?: string;
          tool_call_id?: string;
          tool_name?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tool_executions_retry_of_fkey";
            columns: ["retry_of"];
            isOneToOne: false;
            referencedRelation: "tool_executions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tool_executions_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "agent_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      workspace_members: {
        Row: {
          created_at: string;
          role: Database["public"]["Enums"]["workspace_member_role"];
          user_id: string;
          workspace_id: string;
        };
        Insert: {
          created_at?: string;
          role?: Database["public"]["Enums"]["workspace_member_role"];
          user_id: string;
          workspace_id: string;
        };
        Update: {
          created_at?: string;
          role?: Database["public"]["Enums"]["workspace_member_role"];
          user_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      workspace_provider_audit_events: {
        Row: {
          action: string;
          actor_user_id: string | null;
          created_at: string;
          id: string;
          provider_config_id: string | null;
          request_id: string | null;
          safe_details: Json;
          workspace_id: string;
        };
        Insert: {
          action: string;
          actor_user_id?: string | null;
          created_at?: string;
          id?: string;
          provider_config_id?: string | null;
          request_id?: string | null;
          safe_details?: Json;
          workspace_id: string;
        };
        Update: {
          action?: string;
          actor_user_id?: string | null;
          created_at?: string;
          id?: string;
          provider_config_id?: string | null;
          request_id?: string | null;
          safe_details?: Json;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workspace_provider_audit_events_provider_config_id_fkey";
            columns: ["provider_config_id"];
            isOneToOne: false;
            referencedRelation: "workspace_provider_configs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "workspace_provider_audit_events_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      workspace_provider_configs: {
        Row: {
          adapter: string;
          api_key_last_four: string;
          api_key_secret_id: string;
          base_url: string;
          created_at: string;
          created_by: string | null;
          display_name: string;
          enabled: boolean;
          id: string;
          last_test_error_code: string | null;
          last_test_status: string;
          last_tested_at: string | null;
          revision: number;
          updated_at: string;
          updated_by: string | null;
          workspace_id: string | null;
        };
        Insert: {
          adapter?: string;
          api_key_last_four: string;
          api_key_secret_id: string;
          base_url: string;
          created_at?: string;
          created_by?: string | null;
          display_name: string;
          enabled?: boolean;
          id?: string;
          last_test_error_code?: string | null;
          last_test_status?: string;
          last_tested_at?: string | null;
          revision?: number;
          updated_at?: string;
          updated_by?: string | null;
          workspace_id?: string | null;
        };
        Update: {
          adapter?: string;
          api_key_last_four?: string;
          api_key_secret_id?: string;
          base_url?: string;
          created_at?: string;
          created_by?: string | null;
          display_name?: string;
          enabled?: boolean;
          id?: string;
          last_test_error_code?: string | null;
          last_test_status?: string;
          last_tested_at?: string | null;
          revision?: number;
          updated_at?: string;
          updated_by?: string | null;
          workspace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "workspace_provider_configs_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      workspace_provider_models: {
        Row: {
          capabilities: Json;
          catalog_key: string;
          created_at: string;
          display_name: string;
          enabled: boolean;
          id: string;
          modality: string;
          provider_config_id: string;
          updated_at: string;
          upstream_model_id: string;
        };
        Insert: {
          capabilities?: Json;
          catalog_key?: string;
          created_at?: string;
          display_name: string;
          enabled?: boolean;
          id?: string;
          modality: string;
          provider_config_id: string;
          updated_at?: string;
          upstream_model_id: string;
        };
        Update: {
          capabilities?: Json;
          catalog_key?: string;
          created_at?: string;
          display_name?: string;
          enabled?: boolean;
          id?: string;
          modality?: string;
          provider_config_id?: string;
          updated_at?: string;
          upstream_model_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workspace_provider_models_provider_config_id_fkey";
            columns: ["provider_config_id"];
            isOneToOne: false;
            referencedRelation: "workspace_provider_configs";
            referencedColumns: ["id"];
          },
        ];
      };
      workspace_settings: {
        Row: {
          created_at: string;
          default_model: string;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          created_at?: string;
          default_model?: string;
          updated_at?: string;
          workspace_id: string;
        };
        Update: {
          created_at?: string;
          default_model?: string;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workspace_settings_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: true;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      workspace_skills: {
        Row: {
          config: Json | null;
          enabled: boolean;
          id: string;
          installed_at: string;
          installed_by: string | null;
          skill_id: string;
          workspace_id: string;
        };
        Insert: {
          config?: Json | null;
          enabled?: boolean;
          id?: string;
          installed_at?: string;
          installed_by?: string | null;
          skill_id: string;
          workspace_id: string;
        };
        Update: {
          config?: Json | null;
          enabled?: boolean;
          id?: string;
          installed_at?: string;
          installed_by?: string | null;
          skill_id?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workspace_skills_skill_id_fkey";
            columns: ["skill_id"];
            isOneToOne: false;
            referencedRelation: "skills";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "workspace_skills_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      workspaces: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          owner_user_id: string;
          type: Database["public"]["Enums"]["workspace_type"];
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          owner_user_id: string;
          type: Database["public"]["Enums"]["workspace_type"];
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          owner_user_id?: string;
          type?: Database["public"]["Enums"]["workspace_type"];
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      bootstrap_viewer: {
        Args: { p_email: string; p_user_id: string; p_user_meta: Json };
        Returns: string;
      };
      can_access_agent_run: {
        Args: { target_run_id: string };
        Returns: boolean;
      };
      claim_daily_credits: {
        Args: { p_amount: number; p_workspace_id: string };
        Returns: boolean;
      };
      create_project_with_canvas: {
        Args: {
          p_canvas_name?: string;
          p_description?: string;
          p_name: string;
          p_slug: string;
          p_workspace_id: string;
        };
        Returns: Json;
      };
      deduct_credits: {
        Args: {
          p_amount: number;
          p_description?: string;
          p_job_id?: string;
          p_user_id: string;
          p_workspace_id: string;
        };
        Returns: string;
      };
      grant_plan_credits: {
        Args: {
          p_credits: number;
          p_plan: Database["public"]["Enums"]["subscription_plan"];
          p_workspace_id: string;
        };
        Returns: number;
      };
      grant_subscription_credits: {
        Args: {
          p_payment_fingerprint: string;
          p_plan: Database["public"]["Enums"]["subscription_plan"];
          p_workspace_id: string;
        };
        Returns: boolean;
      };
      increment_job_attempt: {
        Args: { p_job_id: string };
        Returns: {
          attempt_count: number;
          max_attempts: number;
        }[];
      };
      loomic_asset_gc_claim: {
        Args: { p_asset_id: string; p_now?: string };
        Returns: {
          bucket: string;
          claim_token: string;
          object_path: string;
        }[];
      };
      loomic_asset_gc_finalize: {
        Args: { p_asset_id: string; p_claim_token: string };
        Returns: boolean;
      };
      loomic_asset_gc_prepare_delete: {
        Args: { p_asset_id: string; p_claim_token: string };
        Returns: boolean;
      };
      loomic_canvas_asset_ref_upsert: {
        Args: { p_asset_id: string; p_canvas_id: string; p_element_id: string };
        Returns: boolean;
      };
      loomic_canvas_asset_refs_replace: {
        Args: { p_canvas_id: string; p_refs: Json };
        Returns: string[];
      };
      loomic_agent_design_mutate: {
        Args: {
          p_actor_user_id: string;
          p_agent_run_id: string;
          p_commands: Json;
          p_confirmation_id?: string;
          p_destructive_confirmed?: boolean;
          p_design_id: string;
          p_expected_revision: number;
          p_expected_template_revision?: number;
          p_idempotency_key: string;
          p_next_scene: Json;
          p_operation: string;
          p_template_id?: string;
          p_tool_execution_id: string;
        };
        Returns: Json;
      };
      loomic_catalog_create: {
        Args: {
          p_actor_user_id: string;
          p_entity_kind: string;
          p_payload: Json;
          p_request_id: string;
          p_scope: string;
          p_workspace_id: string;
        };
        Returns: Json;
      };
      loomic_catalog_set_deleted: {
        Args: {
          p_actor_user_id: string;
          p_deleted: boolean;
          p_entity_id: string;
          p_entity_kind: string;
          p_expected_revision: number;
          p_request_id: string;
        };
        Returns: Json;
      };
      loomic_catalog_set_status: {
        Args: {
          p_actor_user_id: string;
          p_entity_id: string;
          p_entity_kind: string;
          p_expected_revision: number;
          p_request_id: string;
          p_status: string;
        };
        Returns: Json;
      };
      loomic_catalog_update: {
        Args: {
          p_actor_user_id: string;
          p_entity_id: string;
          p_entity_kind: string;
          p_expected_revision: number;
          p_patch: Json;
          p_request_id: string;
        };
        Returns: Json;
      };
      loomic_design_binding_reconcile: {
        Args: { p_limit?: number };
        Returns: Json;
      };
      loomic_design_copy: {
        Args: {
          p_actor_user_id: string;
          p_canvas_element_id: string;
          p_canvas_id: string;
          p_expected_canvas_revision: number;
          p_name: string;
          p_node_height: number;
          p_node_width: number;
          p_node_x: number;
          p_node_y: number;
          p_request_id: string;
          p_source_design_id: string;
        };
        Returns: Json;
      };
      loomic_design_create: {
        Args: {
          p_background?: string;
          p_canvas_element_id: string;
          p_canvas_id: string;
          p_expected_canvas_revision: number;
          p_height: number;
          p_name: string;
          p_node_height: number;
          p_node_width: number;
          p_node_x: number;
          p_node_y: number;
          p_request_id: string;
          p_template_id?: string;
          p_width: number;
        };
        Returns: Json;
      };
      loomic_design_finalization_candidates: {
        Args: { p_limit?: number };
        Returns: {
          attempt_count: number;
          canceled_at: string | null;
          canvas_id: string | null;
          completed_at: string | null;
          created_at: string;
          created_by: string;
          credits_cost: number | null;
          credits_transaction_id: string | null;
          design_id: string | null;
          error_code: string | null;
          error_message: string | null;
          failed_at: string | null;
          id: string;
          job_type: Database["public"]["Enums"]["background_job_type"];
          max_attempts: number;
          payload: Json;
          project_id: string | null;
          queue_name: string;
          result: Json | null;
          session_id: string | null;
          started_at: string | null;
          status: Database["public"]["Enums"]["background_job_status"];
          target_kind: string | null;
          thread_id: string | null;
          updated_at: string;
          workspace_id: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "background_jobs";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      loomic_design_mutate: {
        Args: {
          p_actor_kind: string;
          p_actor_user_id: string;
          p_agent_run_id?: string;
          p_commands: Json;
          p_design_id: string;
          p_expected_revision: number;
          p_idempotency_key: string;
          p_next_scene: Json;
          p_tool_execution_id?: string;
        };
        Returns: Json;
      };
      loomic_design_outbox_claim: {
        Args: { p_claim_token: string; p_limit: number; p_now?: string };
        Returns: {
          attempt_count: number;
          available_at: string;
          claim_token: string | null;
          claimed_at: string | null;
          created_at: string;
          design_id: string;
          event_type: string;
          id: string;
          last_error: string | null;
          payload: Json;
          published_at: string | null;
          revision: number;
          status: string;
          workspace_id: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "design_event_outbox";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      loomic_design_outbox_mark_failed: {
        Args: {
          p_claim_token: string;
          p_error: string;
          p_event_id: string;
          p_now?: string;
        };
        Returns: boolean;
      };
      loomic_design_outbox_mark_published: {
        Args: {
          p_claim_token: string;
          p_event_id: string;
          p_published_at?: string;
        };
        Returns: boolean;
      };
      loomic_design_outbox_reconcile: {
        Args: { p_now?: string };
        Returns: number;
      };
      loomic_design_preview_commit: {
        Args: {
          p_actor_user_id: string;
          p_design_id: string;
          p_expected_revision: number;
          p_idempotency_key: string;
          p_preview_asset_object_id: string;
          p_preview_revision: number;
        };
        Returns: Json;
      };
      loomic_design_preview_mark_error: {
        Args: {
          p_error_code: string;
          p_error_message: string;
          p_job_id: string;
        };
        Returns: Json;
      };
      loomic_design_preview_queue: {
        Args: {
          p_actor_user_id: string;
          p_design_id: string;
          p_expected_revision: number;
          p_idempotency_key: string;
          p_job_id: string;
        };
        Returns: Json;
      };
      loomic_design_reconcile_references: {
        Args: { p_design_id: string };
        Returns: Json;
      };
      loomic_design_rename: {
        Args: {
          p_actor_user_id: string;
          p_design_id: string;
          p_expected_revision: number;
          p_idempotency_key: string;
          p_name: string;
        };
        Returns: Json;
      };
      loomic_design_resource_collection_list: {
        Args: {
          p_collection: string;
          p_cursor_id: string;
          p_cursor_used_at: string;
          p_limit: number;
          p_workspace_id: string;
        };
        Returns: {
          item: Json;
        }[];
      };
      loomic_design_resources_list: {
        Args: {
          p_aspect_ratio: string;
          p_category_id: string;
          p_cursor_id: string;
          p_cursor_updated_at: string;
          p_format: string;
          p_kind: string;
          p_limit: number;
          p_query: string;
          p_scope: string;
          p_status: string;
          p_tag_id: string;
        };
        Returns: {
          item: Json;
        }[];
      };
      loomic_design_restore: {
        Args: {
          p_actor_user_id: string;
          p_design_id: string;
          p_expected_revision: number;
          p_idempotency_key: string;
        };
        Returns: Json;
      };
      loomic_design_soft_delete: {
        Args: {
          p_actor_user_id: string;
          p_design_id: string;
          p_expected_revision: number;
          p_idempotency_key: string;
        };
        Returns: Json;
      };
      loomic_job_finalization_claim: {
        Args: { p_command_id: string; p_job_id: string; p_now?: string };
        Returns: Json;
      };
      loomic_job_finalization_finish: {
        Args: {
          p_command_id: string;
          p_error_code?: string;
          p_error_message?: string;
          p_job_id: string;
          p_result?: Json;
          p_status: string;
        };
        Returns: Json;
      };
      loomic_orphan_asset_claim: {
        Args: { p_asset_id: string };
        Returns: {
          bucket: string;
          object_path: string;
        }[];
      };
      loomic_orphan_asset_finalize: {
        Args: { p_asset_id: string };
        Returns: boolean;
      };
      loomic_provider_config_delete: {
        Args: {
          p_actor_user_id: string;
          p_provider_config_id: string;
          p_workspace_id: string;
        };
        Returns: boolean;
      };
      loomic_provider_config_update: {
        Args: {
          p_actor_user_id?: string;
          p_base_url: string;
          p_display_name: string;
          p_enabled: boolean;
          p_expected_revision: number;
          p_models?: Json;
          p_new_secret?: string;
          p_new_secret_last_four?: string;
          p_provider_config_id: string;
          p_workspace_id: string;
        };
        Returns: string;
      };
      loomic_provider_job_snapshot_resolve: {
        Args: { p_background_job_id: string; p_workspace_id: string };
        Returns: {
          adapter: string;
          api_key: string;
          base_url: string;
          billing_credits_cost: number;
          billing_pricing_version: string;
          billing_unit: string;
          capabilities: Json;
          catalog_key: string;
          modality: string;
          provider_config_id: string;
          provider_revision: number;
          snapshot_id: string;
          upstream_model_id: string;
        }[];
      };
      loomic_provider_run_snapshot_resolve: {
        Args: { p_agent_run_id: string; p_workspace_id: string };
        Returns: {
          adapter: string;
          api_key: string;
          base_url: string;
          billing_credits_cost: number;
          billing_pricing_version: string;
          billing_unit: string;
          capabilities: Json;
          catalog_key: string;
          modality: string;
          provider_config_id: string;
          provider_revision: number;
          snapshot_id: string;
          upstream_model_id: string;
        }[];
      };
      loomic_provider_secret_create: {
        Args: { p_description?: string; p_name: string; p_secret: string };
        Returns: string;
      };
      loomic_provider_secret_delete: {
        Args: { p_secret_id: string };
        Returns: undefined;
      };
      loomic_provider_secret_read: {
        Args: { p_secret_id: string };
        Returns: string;
      };
      loomic_provider_secret_update: {
        Args: { p_secret: string; p_secret_id: string };
        Returns: undefined;
      };
      loomic_provider_snapshot_create: {
        Args: {
          p_agent_run_id?: string;
          p_background_job_id?: string;
          p_billing_credits_cost?: number;
          p_billing_pricing_version?: string;
          p_billing_unit?: string;
          p_catalog_key: string;
          p_workspace_id: string;
        };
        Returns: string;
      };
      loomic_provider_snapshot_release: {
        Args: { p_snapshot_id: string; p_workspace_id: string };
        Returns: boolean;
      };
      loomic_record_resource_recent_use: {
        Args: { p_resource_id: string; p_workspace_id: string };
        Returns: Json;
      };
      loomic_resource_favorite_set: {
        Args: { p_favorite: boolean; p_resource_id: string };
        Returns: Json;
      };
      loomic_resource_import_claim: {
        Args: { p_claim_token: string; p_limit?: number };
        Returns: {
          attempt_count: number;
          available_at: string;
          background_job_id: string | null;
          claim_token: string | null;
          claimed_at: string | null;
          completed_at: string | null;
          completed_items: number;
          created_at: string;
          created_by: string | null;
          failed_items: number;
          id: string;
          input_hash: string | null;
          last_error: string | null;
          request_id: string | null;
          scope: string;
          source: Json;
          source_kind: string;
          started_at: string | null;
          status: string;
          total_items: number;
          workspace_id: string | null;
        }[];
        SetofOptions: {
          from: "*";
          to: "resource_import_jobs";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      loomic_resource_import_create: {
        Args: {
          p_actor_user_id: string;
          p_request_id: string;
          p_scope: string;
          p_source: Json;
          p_source_kind: string;
          p_workspace_id: string;
        };
        Returns: Json;
      };
      loomic_resource_import_complete: {
        Args: { p_claim_token: string; p_import_job_id: string };
        Returns: Json;
      };
      loomic_resource_import_defer: {
        Args: {
          p_claim_token: string;
          p_delay_seconds: number;
          p_error_message: string;
          p_import_job_id: string;
        };
        Returns: Json;
      };
      loomic_resource_import_finalize_item: {
        Args: {
          p_asset_object_id: string;
          p_claim_token: string;
          p_error_code: string;
          p_error_message: string;
          p_import_job_id: string;
          p_item_id: string;
          p_result_entity_id: string;
          p_result_entity_kind: string;
          p_status: string;
        };
        Returns: Json;
      };
      loomic_resource_import_manifest_enqueue: {
        Args: {
          p_actor_user_id: string;
          p_manifest_items: Json;
          p_request_id: string;
          p_scope: string;
          p_workspace_id: string;
        };
        Returns: Json;
      };
      refund_credits: {
        Args: {
          p_amount: number;
          p_description?: string;
          p_job_id: string;
          p_user_id: string;
          p_workspace_id: string;
        };
        Returns: string;
      };
    };
    Enums: {
      background_job_status:
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "canceled"
        | "dead_letter";
      background_job_type:
        | "image_generation"
        | "video_generation"
        | "code_execution"
        | "design_preview"
        | "design_export"
        | "design_resource_import";
      billing_period: "monthly" | "yearly";
      brand_kit_asset_type: "color" | "font" | "logo" | "image";
      credit_transaction_type:
        | "subscription_grant"
        | "daily_grant"
        | "purchase"
        | "generation_deduct"
        | "generation_refund"
        | "admin_adjustment"
        | "bonus";
      subscription_plan: "free" | "starter" | "pro" | "ultra" | "business";
      workspace_member_role: "owner" | "admin" | "member";
      workspace_type: "personal" | "team";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<
  keyof Database,
  "public"
>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  langgraph: {
    Enums: {},
  },
  public: {
    Enums: {
      background_job_status: [
        "queued",
        "running",
        "succeeded",
        "failed",
        "canceled",
        "dead_letter",
      ],
      background_job_type: [
        "image_generation",
        "video_generation",
        "code_execution",
        "design_preview",
        "design_export",
        "design_resource_import",
      ],
      billing_period: ["monthly", "yearly"],
      brand_kit_asset_type: ["color", "font", "logo", "image"],
      credit_transaction_type: [
        "subscription_grant",
        "daily_grant",
        "purchase",
        "generation_deduct",
        "generation_refund",
        "admin_adjustment",
        "bonus",
      ],
      subscription_plan: ["free", "starter", "pro", "ultra", "business"],
      workspace_member_role: ["owner", "admin", "member"],
      workspace_type: ["personal", "team"],
    },
  },
} as const;
