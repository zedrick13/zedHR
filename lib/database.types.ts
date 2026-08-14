Connecting to db 5432
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      AUD_SystemLog: {
        Row: {
          action_type: string
          actor_id: string | null
          created_at: string
          id: string
          new_value: Json | null
          organization_id: string
          previous_value: Json | null
          target_id: string | null
        }
        Insert: {
          action_type: string
          actor_id?: string | null
          created_at?: string
          id?: string
          new_value?: Json | null
          organization_id: string
          previous_value?: Json | null
          target_id?: string | null
        }
        Update: {
          action_type?: string
          actor_id?: string | null
          created_at?: string
          id?: string
          new_value?: Json | null
          organization_id?: string
          previous_value?: Json | null
          target_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "AUD_SystemLog_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "MST_User"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "AUD_SystemLog_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "MST_Organization"
            referencedColumns: ["id"]
          },
        ]
      }
      MST_Department: {
        Row: {
          created_at: string
          id: string
          manager_id: string | null
          name: string
          organization_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          manager_id?: string | null
          name: string
          organization_id: string
        }
        Update: {
          created_at?: string
          id?: string
          manager_id?: string | null
          name?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_department_manager"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "MST_User"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "MST_Department_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "MST_Organization"
            referencedColumns: ["id"]
          },
        ]
      }
      MST_Holiday: {
        Row: {
          created_at: string
          date: string
          id: string
          name: string
          organization_id: string
          region_scope: string | null
          type: string
        }
        Insert: {
          created_at?: string
          date: string
          id?: string
          name: string
          organization_id: string
          region_scope?: string | null
          type: string
        }
        Update: {
          created_at?: string
          date?: string
          id?: string
          name?: string
          organization_id?: string
          region_scope?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "MST_Holiday_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "MST_Organization"
            referencedColumns: ["id"]
          },
        ]
      }
      MST_MfaBackupCode: {
        Row: {
          code_hash: string
          created_at: string
          id: string
          is_used: boolean
          organization_id: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          code_hash: string
          created_at?: string
          id?: string
          is_used?: boolean
          organization_id: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          code_hash?: string
          created_at?: string
          id?: string
          is_used?: boolean
          organization_id?: string
          used_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "MST_MfaBackupCode_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "MST_Organization"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "MST_MfaBackupCode_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "MST_User"
            referencedColumns: ["id"]
          },
        ]
      }
      MST_Organization: {
        Row: {
          created_at: string
          data_retention_days: number
          display_locale: string
          geofence_latitude: number | null
          geofence_longitude: number | null
          geofence_radius_m: number | null
          id: string
          max_cb_minutes: number
          min_lb_minutes: number
          name: string
          pay_cycle_start_date: string
          pay_cycle_type: string
          timezone: string
        }
        Insert: {
          created_at?: string
          data_retention_days?: number
          display_locale?: string
          geofence_latitude?: number | null
          geofence_longitude?: number | null
          geofence_radius_m?: number | null
          id?: string
          max_cb_minutes?: number
          min_lb_minutes?: number
          name: string
          pay_cycle_start_date?: string
          pay_cycle_type: string
          timezone?: string
        }
        Update: {
          created_at?: string
          data_retention_days?: number
          display_locale?: string
          geofence_latitude?: number | null
          geofence_longitude?: number | null
          geofence_radius_m?: number | null
          id?: string
          max_cb_minutes?: number
          min_lb_minutes?: number
          name?: string
          pay_cycle_start_date?: string
          pay_cycle_type?: string
          timezone?: string
        }
        Relationships: []
      }
      MST_User: {
        Row: {
          avatar_path: string | null
          created_at: string
          department_id: string | null
          first_name: string
          id: string
          is_active: boolean
          last_name: string
          mfa_enrolled: boolean
          organization_id: string
          role: string
          role_changed_at: string
          scheduled_purge_at: string | null
          terminated_at: string | null
        }
        Insert: {
          avatar_path?: string | null
          created_at?: string
          department_id?: string | null
          first_name: string
          id: string
          is_active?: boolean
          last_name: string
          mfa_enrolled?: boolean
          organization_id: string
          role: string
          role_changed_at?: string
          scheduled_purge_at?: string | null
          terminated_at?: string | null
        }
        Update: {
          avatar_path?: string | null
          created_at?: string
          department_id?: string | null
          first_name?: string
          id?: string
          is_active?: boolean
          last_name?: string
          mfa_enrolled?: boolean
          organization_id?: string
          role?: string
          role_changed_at?: string
          scheduled_purge_at?: string | null
          terminated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "MST_User_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "MST_Department"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "MST_User_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "MST_Organization"
            referencedColumns: ["id"]
          },
        ]
      }
      MST_UserInvitation: {
        Row: {
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string
          is_used: boolean
          organization_id: string
          revoked_at: string | null
          revoked_by: string | null
          role: string
          token: string
        }
        Insert: {
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by: string
          is_used?: boolean
          organization_id: string
          revoked_at?: string | null
          revoked_by?: string | null
          role: string
          token?: string
        }
        Update: {
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          is_used?: boolean
          organization_id?: string
          revoked_at?: string | null
          revoked_by?: string | null
          role?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "MST_UserInvitation_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "MST_User"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "MST_UserInvitation_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "MST_Organization"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "MST_UserInvitation_revoked_by_fkey"
            columns: ["revoked_by"]
            isOneToOne: false
            referencedRelation: "MST_User"
            referencedColumns: ["id"]
          },
        ]
      }
      NTF_Notification: {
        Row: {
          body: string
          created_at: string
          dedupe_key: string | null
          id: string
          is_read: boolean
          link_path: string | null
          organization_id: string
          read_at: string | null
          recipient_id: string
          template: string
          title: string
        }
        Insert: {
          body: string
          created_at?: string
          dedupe_key?: string | null
          id?: string
          is_read?: boolean
          link_path?: string | null
          organization_id: string
          read_at?: string | null
          recipient_id: string
          template: string
          title: string
        }
        Update: {
          body?: string
          created_at?: string
          dedupe_key?: string | null
          id?: string
          is_read?: boolean
          link_path?: string | null
          organization_id?: string
          read_at?: string | null
          recipient_id?: string
          template?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "NTF_Notification_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "MST_Organization"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "NTF_Notification_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "MST_User"
            referencedColumns: ["id"]
          },
        ]
      }
      RTL_RateLimitEvent: {
        Row: {
          bucket_key: string
          created_at: string
          id: string
          organization_id: string | null
          user_id: string | null
        }
        Insert: {
          bucket_key: string
          created_at?: string
          id?: string
          organization_id?: string | null
          user_id?: string | null
        }
        Update: {
          bucket_key?: string
          created_at?: string
          id?: string
          organization_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "RTL_RateLimitEvent_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "MST_Organization"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "RTL_RateLimitEvent_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "MST_User"
            referencedColumns: ["id"]
          },
        ]
      }
      TIM_CompensableBreak: {
        Row: {
          created_at: string
          end_time: string | null
          id: string
          is_auto_closed: boolean
          organization_id: string
          policy_violation: boolean
          policy_violation_reason: string | null
          start_time: string
          work_session_id: string
        }
        Insert: {
          created_at?: string
          end_time?: string | null
          id?: string
          is_auto_closed?: boolean
          organization_id: string
          policy_violation?: boolean
          policy_violation_reason?: string | null
          start_time: string
          work_session_id: string
        }
        Update: {
          created_at?: string
          end_time?: string | null
          id?: string
          is_auto_closed?: boolean
          organization_id?: string
          policy_violation?: boolean
          policy_violation_reason?: string | null
          start_time?: string
          work_session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "TIM_CompensableBreak_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "MST_Organization"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "TIM_CompensableBreak_work_session_id_fkey"
            columns: ["work_session_id"]
            isOneToOne: false
            referencedRelation: "TIM_WorkSession"
            referencedColumns: ["id"]
          },
        ]
      }
      TIM_CorrectionRequest: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          reason: string
          rejection_note: string | null
          request_type: string
          requested_timestamp: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          user_id: string
          work_session_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          reason: string
          rejection_note?: string | null
          request_type: string
          requested_timestamp: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          user_id: string
          work_session_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          reason?: string
          rejection_note?: string | null
          request_type?: string
          requested_timestamp?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          user_id?: string
          work_session_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "TIM_CorrectionRequest_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "MST_Organization"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "TIM_CorrectionRequest_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "MST_User"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "TIM_CorrectionRequest_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "MST_User"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "TIM_CorrectionRequest_work_session_id_fkey"
            columns: ["work_session_id"]
            isOneToOne: false
            referencedRelation: "TIM_WorkSession"
            referencedColumns: ["id"]
          },
        ]
      }
      TIM_NonCompensableBreak: {
        Row: {
          created_at: string
          end_time: string | null
          id: string
          is_auto_closed: boolean
          organization_id: string
          policy_violation: boolean
          policy_violation_reason: string | null
          start_time: string
          work_session_id: string
        }
        Insert: {
          created_at?: string
          end_time?: string | null
          id?: string
          is_auto_closed?: boolean
          organization_id: string
          policy_violation?: boolean
          policy_violation_reason?: string | null
          start_time: string
          work_session_id: string
        }
        Update: {
          created_at?: string
          end_time?: string | null
          id?: string
          is_auto_closed?: boolean
          organization_id?: string
          policy_violation?: boolean
          policy_violation_reason?: string | null
          start_time?: string
          work_session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "TIM_NonCompensableBreak_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "MST_Organization"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "TIM_NonCompensableBreak_work_session_id_fkey"
            columns: ["work_session_id"]
            isOneToOne: false
            referencedRelation: "TIM_WorkSession"
            referencedColumns: ["id"]
          },
        ]
      }
      TIM_SyncConflict: {
        Row: {
          created_at: string
          details: Json
          failed_action: string
          id: string
          organization_id: string
          user_id: string
          work_session_id: string | null
        }
        Insert: {
          created_at?: string
          details?: Json
          failed_action: string
          id?: string
          organization_id: string
          user_id: string
          work_session_id?: string | null
        }
        Update: {
          created_at?: string
          details?: Json
          failed_action?: string
          id?: string
          organization_id?: string
          user_id?: string
          work_session_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "TIM_SyncConflict_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "MST_Organization"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "TIM_SyncConflict_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "MST_User"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "TIM_SyncConflict_work_session_id_fkey"
            columns: ["work_session_id"]
            isOneToOne: false
            referencedRelation: "TIM_WorkSession"
            referencedColumns: ["id"]
          },
        ]
      }
      TIM_WorkArrangement: {
        Row: {
          arrangement: string
          created_at: string
          effective_date: string
          expires_date: string | null
          id: string
          organization_id: string
          target_id: string
          target_level: string
        }
        Insert: {
          arrangement: string
          created_at?: string
          effective_date: string
          expires_date?: string | null
          id?: string
          organization_id: string
          target_id: string
          target_level: string
        }
        Update: {
          arrangement?: string
          created_at?: string
          effective_date?: string
          expires_date?: string | null
          id?: string
          organization_id?: string
          target_id?: string
          target_level?: string
        }
        Relationships: [
          {
            foreignKeyName: "TIM_WorkArrangement_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "MST_Organization"
            referencedColumns: ["id"]
          },
        ]
      }
      TIM_WorkSession: {
        Row: {
          clock_in_geo_status: string
          clock_in_ip: unknown
          clock_in_lat: number | null
          clock_in_lng: number | null
          clock_in_outside_boundary: boolean
          clock_in_time: string
          clock_out_geo_status: string | null
          clock_out_ip: unknown
          clock_out_lat: number | null
          clock_out_lng: number | null
          clock_out_outside_boundary: boolean
          clock_out_time: string | null
          created_at: string
          flagged_long_running: boolean
          id: string
          organization_id: string
          user_id: string
        }
        Insert: {
          clock_in_geo_status: string
          clock_in_ip?: unknown
          clock_in_lat?: number | null
          clock_in_lng?: number | null
          clock_in_outside_boundary?: boolean
          clock_in_time: string
          clock_out_geo_status?: string | null
          clock_out_ip?: unknown
          clock_out_lat?: number | null
          clock_out_lng?: number | null
          clock_out_outside_boundary?: boolean
          clock_out_time?: string | null
          created_at?: string
          flagged_long_running?: boolean
          id?: string
          organization_id: string
          user_id: string
        }
        Update: {
          clock_in_geo_status?: string
          clock_in_ip?: unknown
          clock_in_lat?: number | null
          clock_in_lng?: number | null
          clock_in_outside_boundary?: boolean
          clock_in_time?: string
          clock_out_geo_status?: string | null
          clock_out_ip?: unknown
          clock_out_lat?: number | null
          clock_out_lng?: number | null
          clock_out_outside_boundary?: boolean
          clock_out_time?: string | null
          created_at?: string
          flagged_long_running?: boolean
          id?: string
          organization_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "TIM_WorkSession_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "MST_Organization"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "TIM_WorkSession_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "MST_User"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

