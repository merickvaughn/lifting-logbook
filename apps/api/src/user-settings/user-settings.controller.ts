import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { UserSettingsResponse } from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { UpdateSettingsDto } from './update-settings.dto';

@Controller('users/me/settings')
export class UserSettingsController {
  constructor(@Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory) {}

  @Get()
  async getSettings(@CurrentUser() user: AuthUser): Promise<UserSettingsResponse> {
    const { userSettings } = await this.factory.forUser(user);
    return userSettings.getSettings();
  }

  @Patch()
  async updateSettings(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateSettingsDto,
  ): Promise<UserSettingsResponse> {
    const { userSettings } = await this.factory.forUser(user);
    return userSettings.upsertSettings(dto);
  }
}
