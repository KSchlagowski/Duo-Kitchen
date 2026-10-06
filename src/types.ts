export interface HouseholdMember {
  userId: string;
  joinedAt: string;
}

export interface Household {
  id: string;
  createdAt: string;
  members: HouseholdMember[];
}
