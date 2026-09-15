export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      counter_sessions: {
        Row: {
          auth_token_hash: string | null
          counter_id: string
          ended_at: string | null
          id: string
          last_seen_at: string | null
          location_id: string
          organization_id: string
          service_id: string
          staff_id: string
          started_at: string
        }
        Insert: {
          auth_token_hash?: string | null
          counter_id: string
          ended_at?: string | null
          id?: string
          last_seen_at?: string | null
          location_id: string
          organization_id: string
          service_id: string
          staff_id: string
          started_at?: string
        }
        Update: {
          auth_token_hash?: string | null
          counter_id?: string
          ended_at?: string | null
          id?: string
          last_seen_at?: string | null
          location_id?: string
          organization_id?: string
          service_id?: string
          staff_id?: string
          started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "counter_sessions_organization_id_location_id_counter_id_fkey"
            columns: ["organization_id", "location_id", "counter_id"]
            isOneToOne: false
            referencedRelation: "counters"
            referencedColumns: ["organization_id", "location_id", "id"]
          },
          {
            foreignKeyName: "counter_sessions_organization_id_location_id_service_id_fkey"
            columns: ["organization_id", "location_id", "service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["organization_id", "location_id", "id"]
          },
          {
            foreignKeyName: "counter_sessions_organization_id_staff_id_fkey"
            columns: ["organization_id", "staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      counters: {
        Row: {
          active: boolean
          archived_at: string | null
          created_at: string
          id: string
          location_id: string
          name: string
          organization_id: string
        }
        Insert: {
          active?: boolean
          archived_at?: string | null
          created_at?: string
          id?: string
          location_id: string
          name: string
          organization_id: string
        }
        Update: {
          active?: boolean
          archived_at?: string | null
          created_at?: string
          id?: string
          location_id?: string
          name?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "counters_organization_id_location_id_fkey"
            columns: ["organization_id", "location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      locations: {
        Row: {
          active: boolean
          address: string | null
          archived_at: string | null
          created_at: string
          description: string | null
          id: string
          name: string
          organization_id: string
          slug: string
          timezone: string
        }
        Insert: {
          active?: boolean
          address?: string | null
          archived_at?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name: string
          organization_id: string
          slug: string
          timezone?: string
        }
        Update: {
          active?: boolean
          address?: string | null
          archived_at?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          organization_id?: string
          slug?: string
          timezone?: string
        }
        Relationships: [
          {
            foreignKeyName: "locations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      managers: {
        Row: {
          created_at: string
          id: string
          name: string
          organization_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          organization_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "managers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      queue_tickets: {
        Row: {
          cancelled_at: string | null
          completed_at: string | null
          counter_id: string | null
          counter_name: string | null
          counter_session_id: string | null
          customer_name: string
          id: string
          joined_at: string
          location_id: string
          organization_id: string
          queue_date: string
          queue_number: string | null
          queue_prefix: string
          queue_sequence: number
          served_by_staff_id: string | null
          service_id: string
          skipped_at: string | null
          started_at: string | null
          status: string
          ticket_token: string
        }
        Insert: {
          cancelled_at?: string | null
          completed_at?: string | null
          counter_id?: string | null
          counter_name?: string | null
          counter_session_id?: string | null
          customer_name: string
          id?: string
          joined_at?: string
          location_id: string
          organization_id: string
          queue_date: string
          queue_number?: string | null
          queue_prefix: string
          queue_sequence: number
          served_by_staff_id?: string | null
          service_id: string
          skipped_at?: string | null
          started_at?: string | null
          status?: string
          ticket_token?: string
        }
        Update: {
          cancelled_at?: string | null
          completed_at?: string | null
          counter_id?: string | null
          counter_name?: string | null
          counter_session_id?: string | null
          customer_name?: string
          id?: string
          joined_at?: string
          location_id?: string
          organization_id?: string
          queue_date?: string
          queue_number?: string | null
          queue_prefix?: string
          queue_sequence?: number
          served_by_staff_id?: string | null
          service_id?: string
          skipped_at?: string | null
          started_at?: string | null
          status?: string
          ticket_token?: string
        }
        Relationships: [
          {
            foreignKeyName: "queue_tickets_organization_id_location_id_service_id_fkey"
            columns: ["organization_id", "location_id", "service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["organization_id", "location_id", "id"]
          },
          {
            foreignKeyName: "queue_tickets_organization_id_served_by_staff_id_fkey"
            columns: ["organization_id", "served_by_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["organization_id", "id"]
          },
          {
            foreignKeyName: "ticket_counter_scope"
            columns: [
              "organization_id",
              "location_id",
              "service_id",
              "served_by_staff_id",
              "counter_id",
              "counter_session_id",
            ]
            isOneToOne: false
            referencedRelation: "counter_sessions"
            referencedColumns: [
              "organization_id",
              "location_id",
              "service_id",
              "staff_id",
              "counter_id",
              "id",
            ]
          },
        ]
      }
      service_daily_counters: {
        Row: {
          last_number: number
          location_id: string
          organization_id: string
          queue_date: string
          service_id: string
        }
        Insert: {
          last_number: number
          location_id: string
          organization_id: string
          queue_date: string
          service_id: string
        }
        Update: {
          last_number?: number
          location_id?: string
          organization_id?: string
          queue_date?: string
          service_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_daily_counters_organization_id_location_id_service_fkey"
            columns: ["organization_id", "location_id", "service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["organization_id", "location_id", "id"]
          },
        ]
      }
      services: {
        Row: {
          active: boolean
          archived_at: string | null
          created_at: string
          default_service_minutes: number
          id: string
          location_id: string
          name: string
          organization_id: string
          queue_prefix: string
        }
        Insert: {
          active?: boolean
          archived_at?: string | null
          created_at?: string
          default_service_minutes: number
          id?: string
          location_id: string
          name: string
          organization_id: string
          queue_prefix: string
        }
        Update: {
          active?: boolean
          archived_at?: string | null
          created_at?: string
          default_service_minutes?: number
          id?: string
          location_id?: string
          name?: string
          organization_id?: string
          queue_prefix?: string
        }
        Relationships: [
          {
            foreignKeyName: "services_organization_id_location_id_fkey"
            columns: ["organization_id", "location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
      staff: {
        Row: {
          active: boolean
          archived_at: string | null
          created_at: string
          id: string
          name: string
          organization_id: string
          pin_hash: string
          staff_code: string
        }
        Insert: {
          active?: boolean
          archived_at?: string | null
          created_at?: string
          id?: string
          name: string
          organization_id: string
          pin_hash: string
          staff_code: string
        }
        Update: {
          active?: boolean
          archived_at?: string | null
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
          pin_hash?: string
          staff_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_assignments: {
        Row: {
          id: string
          location_id: string
          organization_id: string
          service_id: string
          staff_id: string
        }
        Insert: {
          id?: string
          location_id: string
          organization_id: string
          service_id: string
          staff_id: string
        }
        Update: {
          id?: string
          location_id?: string
          organization_id?: string
          service_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_assignments_organization_id_location_id_service_id_fkey"
            columns: ["organization_id", "location_id", "service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["organization_id", "location_id", "id"]
          },
          {
            foreignKeyName: "staff_assignments_organization_id_staff_id_fkey"
            columns: ["organization_id", "staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["organization_id", "id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      call_next_ticket: {
        Args: { p_service_id: string; p_staff_id: string }
        Returns: {
          cancelled_at: string | null
          completed_at: string | null
          counter_id: string | null
          counter_name: string | null
          counter_session_id: string | null
          customer_name: string
          id: string
          joined_at: string
          location_id: string
          organization_id: string
          queue_date: string
          queue_number: string | null
          queue_prefix: string
          queue_sequence: number
          served_by_staff_id: string | null
          service_id: string
          skipped_at: string | null
          started_at: string | null
          status: string
          ticket_token: string
        }[]
        SetofOptions: {
          from: "*"
          to: "queue_tickets"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      cancel_public_queue_ticket: { Args: { p_token: string }; Returns: Json }
      clear_manager_location_history: {
        Args: {
          p_location_id: string
          p_token_hash: string
          p_verified_user_id: string
        }
        Returns: number
      }
      complete_queue_ticket: {
        Args: { p_staff_id: string; p_ticket_id: string }
        Returns: {
          cancelled_at: string | null
          completed_at: string | null
          counter_id: string | null
          counter_name: string | null
          counter_session_id: string | null
          customer_name: string
          id: string
          joined_at: string
          location_id: string
          organization_id: string
          queue_date: string
          queue_number: string | null
          queue_prefix: string
          queue_sequence: number
          served_by_staff_id: string | null
          service_id: string
          skipped_at: string | null
          started_at: string | null
          status: string
          ticket_token: string
        }
        SetofOptions: {
          from: "*"
          to: "queue_tickets"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      consume_auth_attempt: {
        Args: { p_key_hash: string; p_limit: number; p_window_seconds: number }
        Returns: boolean
      }
      create_queue_ticket: {
        Args: {
          p_customer_name: string
          p_location_id: string
          p_service_id: string
        }
        Returns: {
          cancelled_at: string | null
          completed_at: string | null
          counter_id: string | null
          counter_name: string | null
          counter_session_id: string | null
          customer_name: string
          id: string
          joined_at: string
          location_id: string
          organization_id: string
          queue_date: string
          queue_number: string | null
          queue_prefix: string
          queue_sequence: number
          served_by_staff_id: string | null
          service_id: string
          skipped_at: string | null
          started_at: string | null
          status: string
          ticket_token: string
        }
        SetofOptions: {
          from: "*"
          to: "queue_tickets"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      get_manager_analytics: {
        Args: { p_location_id: string; p_range?: string; p_token_hash: string }
        Returns: Json
      }
      get_manager_counter_operations: {
        Args: {
          p_include_archived?: boolean
          p_location_id: string
          p_token_hash: string
        }
        Returns: Json
      }
      get_manager_dashboard: {
        Args: { p_location_id: string; p_token_hash: string }
        Returns: Json
      }
      get_manager_login_context: {
        Args: { p_email: string }
        Returns: {
          credential_version: string
          user_id: string
        }[]
      }
      get_public_queue_location: { Args: { p_slug: string }; Returns: Json }
      get_public_queue_ticket: { Args: { p_token: string }; Returns: Json }
      get_queue_ticket_by_token: {
        Args: { p_ticket_token: string }
        Returns: {
          completed_at: string
          customer_name: string
          joined_at: string
          location_id: string
          queue_number: string
          service_id: string
          skipped_at: string
          started_at: string
          status: string
          ticket_token: string
        }[]
      }
      get_staff_counter_state: {
        Args: {
          p_location_id?: string
          p_service_id?: string
          p_token_hash: string
        }
        Returns: Json
      }
      heartbeat_staff_counter: {
        Args: { p_token_hash: string }
        Returns: string
      }
      issue_app_session: {
        Args: {
          p_credential_version: string
          p_identity_id: string
          p_previous_token_hash?: string
          p_role: string
          p_token_hash: string
        }
        Returns: string
      }
      join_public_queue: {
        Args: {
          p_customer_name: string
          p_key_hash: string
          p_payload_hash: string
          p_service_id: string
          p_slug: string
        }
        Returns: string
      }
      manage_entity_lifecycle: {
        Args: {
          p_action: string
          p_id: string
          p_kind: string
          p_token_hash: string
        }
        Returns: Json
      }
      manage_location_config: {
        Args: {
          p_location_id?: string
          p_operation: string
          p_service_id?: string
          p_token_hash: string
          p_values?: Json
        }
        Returns: string
      }
      manage_location_counter: {
        Args: {
          p_action: string
          p_counter_id?: string
          p_location_id: string
          p_name?: string
          p_token_hash: string
        }
        Returns: string
      }
      manage_staff: {
        Args: {
          p_active?: boolean
          p_assignments?: Json
          p_name?: string
          p_operation: string
          p_pin_hash?: string
          p_staff_code?: string
          p_staff_id?: string
          p_token_hash: string
        }
        Returns: string
      }
      manage_staff_counter: {
        Args: {
          p_action: string
          p_counter_id?: string
          p_location_id?: string
          p_service_id?: string
          p_token_hash: string
        }
        Returns: string
      }
      perform_staff_queue_action: {
        Args: {
          p_action: string
          p_service_id?: string
          p_ticket_id?: string
          p_token_hash: string
        }
        Returns: {
          cancelled_at: string | null
          completed_at: string | null
          counter_id: string | null
          counter_name: string | null
          counter_session_id: string | null
          customer_name: string
          id: string
          joined_at: string
          location_id: string
          organization_id: string
          queue_date: string
          queue_number: string | null
          queue_prefix: string
          queue_sequence: number
          served_by_staff_id: string | null
          service_id: string
          skipped_at: string | null
          started_at: string | null
          status: string
          ticket_token: string
        }[]
        SetofOptions: {
          from: "*"
          to: "queue_tickets"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      preview_manager_lifecycle: {
        Args: { p_id: string; p_kind: string; p_token_hash: string }
        Returns: Json
      }
      prune_auth_state: { Args: never; Returns: undefined }
      prune_customer_join_requests: { Args: never; Returns: undefined }
      resolve_stuck_serving_ticket: {
        Args: {
          p_action: string
          p_location_id: string
          p_ticket_id: string
          p_token_hash: string
        }
        Returns: Json
      }
      revoke_app_session: { Args: { p_token_hash: string }; Returns: undefined }
      skip_queue_ticket: {
        Args: { p_staff_id: string; p_ticket_id: string }
        Returns: {
          cancelled_at: string | null
          completed_at: string | null
          counter_id: string | null
          counter_name: string | null
          counter_session_id: string | null
          customer_name: string
          id: string
          joined_at: string
          location_id: string
          organization_id: string
          queue_date: string
          queue_number: string | null
          queue_prefix: string
          queue_sequence: number
          served_by_staff_id: string | null
          service_id: string
          skipped_at: string | null
          started_at: string | null
          status: string
          ticket_token: string
        }
        SetofOptions: {
          from: "*"
          to: "queue_tickets"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      skip_release_counter: {
        Args: {
          p_counter_id: string
          p_location_id: string
          p_session_id: string
          p_ticket_id: string
          p_token_hash: string
        }
        Returns: string
      }
      validate_app_session: { Args: { p_token_hash: string }; Returns: Json }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

